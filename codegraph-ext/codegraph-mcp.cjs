#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/codegraph-mcp.cjs
 *
 * A dependency-free MCP (Model Context Protocol) server over stdio that surfaces the codegraph
 * edit-loop helpers as FIRST-CLASS TOOLS, sitting next to grep/read_file in the agent's tool list.
 * The whole point: an agent reaches for a native tool by reflex, but ignores an npm script it has to
 * construct through the generic shell and then text-parse. Same logic, better surface.
 *
 * Transport: newline-delimited JSON-RPC 2.0 (the MCP stdio convention). No external deps.
 *
 * Each tool shells out to the existing codegraph .cjs CLIs so there is ONE source of truth for the
 * logic. The target repo is resolved per-call as:  args.projectRoot || $CODEGRAPH_ROOT || <this repo>.
 * That lets the same server serve any checkout/clone (the scripts derive their APP_ROOT from their
 * own location, so we invoke <root>/codegraph-ext/<script>.cjs).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// ---------- MEMO / DEDUP (mechanical, this-process = this-run) ----------
// Diagnosed failure: the model re-fetches the SAME discovery result many times (read-spiral).
// We can't rely on it to stop (prompt rules are ignored), so we intercept: for read-only tools we
// hash the output; a repeat call that produces the BYTE-IDENTICAL result (i.e. nothing changed) is
// HARD-REJECTED with a firm 'you already have this' instead of re-sending the payload. This is
// provably safe (only genuine no-ops are rejected) and self-invalidates: after any edit the output
// differs, so the next call is served fresh. Edits also clear the counters. Scope: read tools only.
const DEDUP_READ = new Set(["codegraph_locate", "codegraph_plan", "codegraph_impact", "codegraph_read"]);
const EDIT_TOOLS = new Set(["codegraph_apply", "codegraph_apply_literal", "codegraph_apply_edit_at_site"]);
// Discovery tools whose failures are GUIDANCE, not fatal. Some hosts (e.g. pydantic-ai based ones)
// turn a hard tool error into a retry and crash the run at max_retries. A bad trace path or a
// not-yet-indexed repo should TEACH the agent, never kill it — so these always return soft.
const SOFT_TOOLS = new Set(["codegraph_locate", "codegraph_trace", "codegraph_plan", "codegraph_impact", "codegraph_read"]);
let memo = new Map(); // key -> { hash, count }   (let, not const: swapped per-root by activateRoot)
function memoKey(name, args) {
  const a = {};
  for (const k of Object.keys(args || {}).sort()) {
    if (k === "projectRoot") continue;
    const v = args[k];
    a[k] = typeof v === "string" ? v.trim().toLowerCase() : v;
  }
  return name + "::" + JSON.stringify(a);
}

// ---------- SUBSUMING read dedup (gate for codegraph_read) ----------
// Exact-hash dedup fired 0 times because the model never re-reads the SAME range — it reads
// overlapping/adjacent slices. So track the line ranges we've already SERVED per file (padded by the
// server's ctx window) and reject a read whose every range is already CONTAINED in what it saw.
const CTX = 6; // read-context.cjs default padding
let servedRanges = new Map(); // fileRel -> [[lo,hi], ...]  (let: swapped per-root by activateRoot)
function parseReadTargets(targets) {
  return (Array.isArray(targets) ? targets : [targets]).filter(Boolean).map(t => {
    const s = String(t);
    let m = s.match(/^(.*):(\d+)-(\d+)$/);
    if (m) return { file: m[1], lo: +m[2], hi: +m[3] };
    m = s.match(/^(.*):(\d+)$/);
    if (m) return { file: m[1], lo: +m[2], hi: +m[2] };
    return { file: s, lo: null, hi: null }; // bare symbol — not range-checkable
  });
}
const isCovered = (file, lo, hi) =>
  (servedRanges.get(file) || []).some(([a, b]) => a <= lo && hi <= b);
// C: fraction of [lo,hi] already covered by served ranges (for overlap-threshold reject)
function coveredFraction(file, lo, hi) {
  const ranges = servedRanges.get(file) || [];
  if (!ranges.length || hi < lo) return 0;
  let covered = 0;
  for (let ln = lo; ln <= hi; ln++) if (ranges.some(([a, b]) => a <= ln && ln <= b)) covered++;
  return covered / (hi - lo + 1);
}
function recordServed(targets) {
  for (const p of parseReadTargets(targets)) {
    if (p.lo == null) continue;
    const arr = servedRanges.get(p.file) || [];
    arr.push([p.lo - CTX, p.hi + CTX]); // record the padded window the model actually saw
    servedRanges.set(p.file, arr);
  }
}
// A: plan/locate/impact already HYDRATE full def/assert bodies inline. Record those line spans as
// 'served' too, so a follow-up codegraph_read of 'what plan already gave me' hits the subsuming
// reject below. Parses the line-NUMBERED chunk format codeChunk() emits under each 'file:line' header.
function recordHydratedFromOutput(text) {
  let curFile = null, runLo = null, runHi = null;
  const flush = () => {
    if (curFile && runLo != null) {
      const a = servedRanges.get(curFile) || [];
      a.push([runLo, runHi]);
      servedRanges.set(curFile, a);
    }
    runLo = runHi = null;
  };
  for (const line of String(text).split("\n")) {
    const body = line.match(/^\s+(\d+)\s\s/); // a hydrated numbered code line: '   14  <code>' (code may be further indented)
    if (body) {
      const ln = +body[1];
      if (runLo == null) runLo = runHi = ln;
      else if (ln === runHi + 1) runHi = ln;
      else { flush(); runLo = runHi = ln; }
    } else {
      flush();
      const h = line.match(/(\S+\.tsx?):\d+/); // a 'file:line' header -> switch current file
      if (h) curFile = h[1];
    }
  }
  flush();
}

// ---------- TURN-CUTTERS: PASS-latch + verify-budget + g3 deferred-verify + call budget ----------
// tokens = turns * growing-context, so the only real savings come from CUTTING TURNS. These are
// mechanical (the model can't opt out): once tests pass we disable tools; we cap total calls and
// verify runs; and we refuse a verify while planned definition sites are still unedited.
const CALL_BUDGET = parseInt(process.env.CG_CALL_BUDGET || "60", 10);
const VERIFY_BUDGET = parseInt(process.env.CG_VERIFY_BUDGET || "4", 10);
const DEFER_CAP = parseInt(process.env.CG_DEFER_CAP || "2", 10);
const READ_BUDGET = parseInt(process.env.CG_READ_BUDGET || "8", 10); // B: cap real codegraph_read execs
const OVERLAP_REJECT = parseFloat(process.env.CG_OVERLAP_REJECT || "0.7"); // C: reject reads >=70% already seen
const SINGLE_STREAK_CAP = parseInt(process.env.CG_SINGLE_STREAK || "3", 10); // D: force batching after N 1-target reads
const LOCATE_BUDGET = parseInt(process.env.CG_LOCATE_BUDGET || "6", 10); // cap the discovery search-spiral
let callCount = 0;
let verifyRuns = 0;
let readRuns = 0;
let locateRuns = 0;
let bestCandidate = null; // {name, loc, strong} — strongest locate hit this run, for the budget nudge
let singleStreak = 0;
let deferCount = 0;
let passed = false;
let resetArmed = false; // set once edits are made; triggers a per-run reset when the tree goes clean again
let lastCallAt = 0; // Fix E: wall-clock of this root's previous call, for idle-gap task boundaries
let plannedDefFiles = new Set(); // definition sites plan said are the source of truth to edit
let editedFiles = new Set(); // files we've actually seen an edit tool touch
let runRoot = null; // Fix D: root pinned on first resolution of a run, so treeClean/edits/auto-reset all
                    // check the SAME tree (arg-less calls no longer drift to cwd/CODEGRAPH_ROOT mid-run).
                    // NOTE: this is the root-RESOLUTION pin ("which tree is the current context"), which is
                    // inherently global; it is deliberately NOT part of the per-root state below.

// ---------- Fix E: PER-ROOT state + IDLE-GAP task boundaries ----------
// Two bugs lived here, and they compounded:
//  (1) the turn-cutter state above was module-GLOBAL, so interleaved tasks across DIFFERENT repos on
//      one long-lived server cross-contaminated each other's budgets/latch.
//  (2) worse, and the one that actually bit: the only automatic reset was `resetArmed && treeClean`,
//      and `resetArmed` is set ONLY when an edit lands. DISCOVERY-ONLY runs (scouts, candidate
//      generators — read/locate/plan, no edits) therefore never armed it, so callCount accumulated
//      MONOTONICALLY across every task for the life of the process. A guardrail meant to stop a
//      runaway loop had degraded into a session-lifetime countdown, and every later run in a session
//      inherited an exhausted budget. Raising CG_CALL_BUDGET would only move that wall, not fix it.
// Fix: keep state in a Map<root, state> (isolation), and treat an IDLE GAP as a task boundary. A
// runaway loop calls back-to-back (sub-second), so an idle gap never occurs WITHIN a loop — the
// guardrail keeps its teeth — but a genuinely new task minutes later starts from a clean budget.
// Deliberately NOT resetting on bare treeClean: a discovery-only spiral never dirties the tree, so
// that would defeat CALL_BUDGET for exactly the read-only loops it exists to stop.
const TASK_IDLE_MS = parseInt(process.env.CG_TASK_IDLE_MS || "90000", 10);
const STATES = new Map(); // resolvedRoot -> state snapshot
let activeRoot = null;
function freshState() {
  return { callCount: 0, verifyRuns: 0, readRuns: 0, locateRuns: 0, bestCandidate: null,
           singleStreak: 0, deferCount: 0, passed: false, resetArmed: false, lastCallAt: 0,
           plannedDefFiles: new Set(), editedFiles: new Set(), memo: new Map(), servedRanges: new Map() };
}
// Save/restore the whole working set in ONE auditable place. This is preferred over sprinkling
// `state.x` across ~40 call sites: a missed site there would silently leak across roots (the very bug
// being fixed), whereas a field missing from THIS list is a single, reviewable omission.
function snapshotState() {
  return { callCount, verifyRuns, readRuns, locateRuns, bestCandidate, singleStreak, deferCount,
           passed, resetArmed, lastCallAt, plannedDefFiles, editedFiles, memo, servedRanges };
}
function loadState(s) {
  ({ callCount, verifyRuns, readRuns, locateRuns, bestCandidate, singleStreak, deferCount,
     passed, resetArmed, lastCallAt, plannedDefFiles, editedFiles, memo, servedRanges } = s);
}
function activateRoot(root) {
  if (activeRoot === root) return;
  if (activeRoot) STATES.set(activeRoot, snapshotState()); // park the outgoing root's state
  const next = STATES.get(root) || freshState();
  STATES.set(root, next);
  loadState(next);
  activeRoot = root;
}
const pathRe = /([\w./-]+\.tsx?):\d+/g;
function collectPlannedDefs(text) {
  const re = /-\s+(\S+):\d+\s+\(definition/g;
  let m;
  while ((m = re.exec(text))) plannedDefFiles.add(m[1]);
}
function collectEdited(args, text) {
  if (Array.isArray(args.edits)) for (const e of args.edits) if (e && e.file) editedFiles.add(e.file);
  let m;
  while ((m = pathRe.exec(String(text)))) editedFiles.add(m[1]);
}

// The MCP server is a LONG-LIVED process shared across sub-agent runs, so turn-cutter state
// (passed latch, budgets, servedRanges…) would LEAK from one task into the next — a fresh run would
// start already-latched. We can't see a 'new task' signal, but the A/B harness restores the working
// tree to clean between runs. So: arm on the first edit; when the tree is clean again AND we're armed,
// a prior run finished + was restored -> reset all per-run state before serving the new run's calls.
function treeClean(root) {
  try {
    // --untracked-files=no: only TRACKED modifications should keep the tree "dirty". Pre-existing
    // untracked junk (stray mocks, generated json) must NOT wedge the PASS-latch open forever —
    // that exact case blocked auto-reset in the field even after the real work was committed.
    const out = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "src"], {
      cwd: root,
      encoding: "utf8",
    });
    return !out.stdout || out.stdout.trim() === "";
  } catch (_) {
    return false; // if git is unavailable, never auto-reset (safer than resetting mid-run)
  }
}
function resetRunState() {
  callCount = verifyRuns = readRuns = locateRuns = singleStreak = deferCount = 0;
  passed = false;
  bestCandidate = null;
  resetArmed = false;
  runRoot = null; // Fix D: re-pin the root on the next call of the new run
  plannedDefFiles.clear();
  editedFiles.clear();
  memo.clear();
  servedRanges.clear();
  // Fix E: persist the cleared state for the active root so the next activateRoot() of a DIFFERENT
  // root parks a reset snapshot, not the pre-reset one.
  if (activeRoot) STATES.set(activeRoot, snapshotState());
}

// Capture the strongest candidate a locate surfaced, so the budget-nudge can NAME the answer the
// model kept re-searching for. Prefer an explicit STRONG MATCH; else the top ranked candidate.
function captureBestCandidate(text) {
  const s = String(text);
  let m = s.match(/>> STRONG MATCH:\s+(\S+)\s+\(([^)]+)\)/);
  if (m) return { name: m[1], loc: m[2], strong: true };
  m = s.match(/\n {2}(\S+)\s+\[[^\]]+\]\s+(\S+:\d+)/);
  if (m) return { name: m[1], loc: m[2], strong: false };
  return null;
}

const DEFAULT_ROOT = path.join(__dirname, "..");
const PROTOCOL_VERSION = "2024-11-05";

// Walk up from a starting dir to the nearest INSTALLED + INDEXED repo
// (one that has both a built graph DB `.codegraph/` and the tooling `codegraph-ext/`).
function autodetectRoot(start) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (
      fs.existsSync(path.join(dir, ".codegraph")) &&
      fs.existsSync(path.join(dir, "codegraph-ext"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

// Resolution order:
//   1) explicit projectRoot arg           (override — "work on THAT repo")
//   2) autodetect from the current dir     (default — "work on wherever I am")
//   3) $CODEGRAPH_ROOT                      (install-time fallback; covers monorepo-root launches)
//   4) this kit's own dir                   (last resort)
// HARD SANDBOX LOCK: when CODEGRAPH_LOCK_ROOT is set, EVERY call resolves to
// exactly that path, full stop — explicit projectRoot args, cwd-autodetection,
// and CODEGRAPH_ROOT are all ignored. This exists so an agent that must be
// confined to an isolated/example repo (e.g. an A/B experiment sandbox) can
// NEVER reach a real repo, even if the agent passes a path, even if cwd
// resolution is wrong, even if the wrong server process got spawned. Leave
// unset for normal multi-repo developer use (kg-sonnet/kg-opus).
const LOCK_ROOT = process.env.CODEGRAPH_LOCK_ROOT
  ? path.resolve(process.env.CODEGRAPH_LOCK_ROOT)
  : null;
if (LOCK_ROOT) {
  process.stderr.write(`[codegraph] SANDBOX LOCK active — all calls confined to ${LOCK_ROOT}\n`);
}

function rootFrom(args) {
  if (LOCK_ROOT) return LOCK_ROOT;
  if (args && args.projectRoot) {
    // Fix D: remember the FIRST explicit root so later ARG-LESS calls in the same run reuse it instead
    // of drifting to cwd-autodetect or the install-time CODEGRAPH_ROOT (a DIFFERENT git tree — which
    // silently broke treeClean/auto-reset in the field, wedging the PASS-latch across tasks).
    if (!runRoot) runRoot = path.resolve(args.projectRoot);
    return args.projectRoot;
  }
  if (runRoot) return runRoot; // reuse the run's established root rather than re-resolving per call
  const detected = autodetectRoot(process.cwd());
  if (detected) { runRoot = detected; return detected; }
  const fallback = process.env.CODEGRAPH_ROOT || DEFAULT_ROOT;
  process.stderr.write(
    `[codegraph] WARN: call had no projectRoot arg and cwd autodetect failed; falling back to ${fallback}. ` +
    `treeClean/auto-reset may check the WRONG tree — pass projectRoot for consistency.\n`
  );
  runRoot = fallback;
  return fallback;
}
function runScript(root, script, scriptArgs) {
  const scriptPath = path.join(root, "codegraph-ext", script);
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, text: `codegraph not found at ${scriptPath} (is projectRoot correct?)` };
  }
  const r = spawnSync("node", [scriptPath, ...scriptArgs], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  return { ok: (r.status ?? 1) === 0, text: out || "(no output)" };
}

// Fail-fast setup check: a repo is usable only if it has BOTH the helper scripts (codegraph-ext/)
// AND a built graph DB (.codegraph/codegraph.db). Missing either is the #1 setup foot-gun — e.g. a
// manual `codegraph index` (DB only) without install.sh (scripts). Return ONE actionable line
// instead of a cryptic "read-context.cjs not found" surfacing from deep inside runScript.
function preflight(root) {
  const hasScripts = fs.existsSync(path.join(root, "codegraph-ext"));
  const hasDb = fs.existsSync(path.join(root, ".codegraph", "codegraph.db"));
  if (hasScripts && hasDb) return null;
  const missing = [];
  if (!hasScripts) missing.push("codegraph-ext/ (helper scripts)");
  if (!hasDb) missing.push(".codegraph/codegraph.db (graph index)");
  return (
    `CODEGRAPH NOT SET UP at ${root} — missing ${missing.join(" and ")}. ` +
    `Fix: run  install.sh ${root}  (idempotent — copies codegraph-ext/ and builds the index). ` +
    `If you meant a DIFFERENT repo, pass the correct projectRoot.`
  );
}

// ---------- tool registry ----------
const TOOLS = {
  codegraph_locate: {
    description:
      "USE THIS FIRST when you know WHAT to change (a behavior/concept) but NOT the symbol name — e.g. " +
      "'graph series color', 'default date range', 'download button label'. Returns ranked candidate " +
      "symbols (name + kind + file:line + the definition line) by searching the knowledge graph's " +
      "symbol names, qualified names, docstrings and signatures. You can also pass a hex/color literal " +
      "(e.g. '#07A093') to find the symbol that owns it. Hand the best result to codegraph_plan. " +
      "Prefer this over grep for turning a task description into a symbol.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Concept words describing what you want to change (e.g. 'graph series color'), or a literal like '#07A093'.",
        },
        projectRoot: {
          type: "string",
          description: "Optional absolute repo path; defaults to $CODEGRAPH_ROOT.",
        },
      },
      required: ["query"],
    },
    run: a => runScript(rootFrom(a), "query.cjs", ["locate", a.query || ""]),
  },
  codegraph_trace: {
    description:
      "FORWARD reachability: 'what does this entry REACH?' — the downward counterpart to codegraph_impact " +
      "('who uses X'). Follows calls/references OUT from an entry up to N hops and (optionally) shows only " +
      "chains that reach a CONCEPT. Entry is a SYMBOL name (best — gives the exact chain, e.g. a config fn " +
      "-> ... -> the shared color constant) or a file/PATH prefix like 'components/chart'. Use it instead " +
      "of guessing feature-local constant names: ask 'does this feature reach the primary color?' and get the " +
      "wiring. Note: chains that cross a JSX/prop boundary aren't tracked — for those, trace from the shared " +
      "component's config symbol, or locate the concept in the shared config module.",
    inputSchema: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          description: "A symbol name (preferred) OR a file/path prefix (e.g. 'components/chart').",
        },
        concept: {
          type: "string",
          description: "Optional concept words (e.g. 'color', 'strokeWidth') — only chains reaching a match are shown.",
        },
        depth: { type: "number", description: "Max hops to follow out (default 3, max 5)." },
        projectRoot: { type: "string", description: "Optional absolute repo path; defaults to $CODEGRAPH_ROOT." },
      },
      required: ["entry"],
    },
    run: a =>
      runScript(rootFrom(a), "query.cjs", [
        "trace",
        a.entry,
        ...(a.concept ? ["--concept", a.concept] : []),
        ...(a.depth ? ["--depth", String(a.depth)] : []),
      ]),
  },
  codegraph_plan: {
    description:
      "USE THIS FIRST to locate every site to edit for a symbol change. Returns the pre-scoped edit " +
      "set (definition + references + covering tests + literal-assert sites) WITH the current line of " +
      "code inline, so you do NOT need to grep or read those files. Prefer this over grep for discovery.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "The symbol/identifier being changed (e.g. METRIC_SERIES_COLORS).",
        },
        change: { type: "string", description: "Short description of the intended change." },
        projectRoot: {
          type: "string",
          description: "Optional absolute repo path; defaults to $CODEGRAPH_ROOT.",
        },
      },
      required: ["symbol"],
    },
    run: a => runScript(rootFrom(a), "query.cjs", ["plan", a.symbol, a.change || "change"]),
  },
  codegraph_impact: {
    description:
      "Raw impact set for a symbol: definition + production references + covering tests + literal-assert " +
      "sites. Use to understand the full blast radius of a change without grepping.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The symbol/identifier to analyze." },
        projectRoot: { type: "string" },
      },
      required: ["symbol"],
    },
    run: a => runScript(rootFrom(a), "query.cjs", ["impact", a.symbol]),
  },
  codegraph_read: {
    description:
      "Read RELEVANT slices of many files in ONE call (instead of many read_file calls). Targets are " +
      "'path:line', 'path:start-end' ranges, or a bare symbol to grep. A single-line/short range is " +
      "auto-expanded to its ENCLOSING function/class so you get a whole semantic unit, not 6 stray lines. " +
      "*** BATCH: pass ALL sites you need in ONE call, e.g. targets:['a.ts:10-40','b.tsx:5','util.ts:100-120']. " +
      "Do NOT call this once per file — list every target together. *** Prefer this over read_file. " +
      "Note: a read already covered by an earlier read is rejected — that code is already in your context.",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description:
            "ALL sites at once: 'file:line', 'file:start-end', and/or bare symbols. e.g. " +
            "['src/a.ts:14-19','src/b.tsx:278','MyComponent']. Batch — don't call once per file.",
        },
        ctx: { type: "number", description: "Context lines each side (default 6)." },
        projectRoot: { type: "string" },
      },
      required: ["targets"],
    },
    run: a =>
      runScript(rootFrom(a), "read-context.cjs", [
        ...(a.targets || []),
        ...(a.ctx ? ["--ctx", String(a.ctx)] : []),
      ]),
  },
  codegraph_apply: {
    description:
      "Apply many anchored edits across files in ONE atomic call (all-or-nothing; a bad/ambiguous anchor " +
      "writes nothing). Set verify:true to run the affected tests exactly once after applying.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description: "Each: { file, old, new, count? }. 'old' must match exactly once unless count is set.",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              old: { type: "string" },
              new: { type: "string" },
              count: {},
            },
            required: ["file", "old", "new"],
          },
        },
        verify: { type: "boolean", description: "Run cg:verify once after a successful apply." },
        projectRoot: { type: "string" },
      },
      required: ["edits"],
    },
    run: a => {
      const tmp = path.join(os.tmpdir(), `cg-apply-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(a.edits || []));
      try {
        return runScript(rootFrom(a), "apply-edits.cjs", [tmp, ...(a.verify ? ["--verify"] : [])]);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch (_) {
          /* ignore */
        }
      }
    },
  },
  codegraph_apply_literal: {
    description:
      "ONE-SHOT value change: swap an exact oldValue->newValue for a symbol, scoped to that symbol's " +
      "definition span (so changing one metric's color/number can't leak into siblings). Optionally " +
      "also updates the covering-test assert lines that hard-code the same value. Use this instead of " +
      "locate+plan+read+apply for simple 'change this constant/color/number' edits \u2014 no anchors to " +
      "build, no file reads. Follow with codegraph_verify.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The symbol whose span to edit (e.g. METRIC_SERIES_COLORS, createSingleSeries)." },
        oldValue: { type: "string", description: "Exact current value/substring to replace (e.g. '#07A093' or 'strokeWidth: 1')." },
        newValue: { type: "string", description: "Replacement value (e.g. '#FF6B6B' or 'strokeWidth: 3')." },
        tests: { type: "boolean", description: "Also swap matching literal-assert lines in covering tests." },
        projectRoot: { type: "string" },
      },
      required: ["symbol", "oldValue", "newValue"],
    },
    run: a =>
      runScript(rootFrom(a), "query.cjs", [
        "swap",
        a.symbol,
        a.oldValue,
        a.newValue,
        ...(a.tests ? ["--tests"] : []),
      ]),
  },
  codegraph_apply_edit_at_site: {
    description:
      "Apply edits BY (file, line) — the server fetches that line's context itself, so you do NOT need to " +
      "read the file first to build an anchor. Use the line NUMBERS shown in plan/locate/impact output. " +
      "Batch every site into ONE call. Each edit: {file, line, find?, replace, expect?}: 'find' = substring " +
      "on that line to swap (omit to replace the whole line — then 'replace' is the full new line incl. " +
      "indentation); 'expect' = optional guard the line must contain. Atomic: any bad site writes nothing. " +
      "VERIFIES ONCE automatically after applying (pass verify:false to skip) — so this ONE call does " +
      "edit+verify in a single turn. This is the DEFAULT, preferred edit path: use it instead of " +
      "codegraph_read + codegraph_apply, and don't call codegraph_verify separately afterward.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          description: "Site edits applied atomically in one call.",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "number", description: "1-based line number (from plan/locate/impact output)." },
              find: { type: "string", description: "Substring on that line to replace; omit to replace the whole line." },
              replace: { type: "string", description: "Replacement text (whole new line if 'find' omitted)." },
              expect: { type: "string", description: "Optional guard: line must contain this or the batch aborts." },
            },
            required: ["file", "line", "replace"],
          },
        },
        verify: { type: "boolean", description: "Run cg:verify once after applying (DEFAULT true; pass false to skip)." },
        projectRoot: { type: "string" },
      },
      required: ["edits"],
    },
    run: a => {
      const tmp = path.join(os.tmpdir(), `cg-site-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(a.edits || []));
      try {
        return runScript(rootFrom(a), "apply-at-site.cjs", [tmp, ...(a.verify === false ? [] : ["--verify"])]);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch (_) {
          /* ignore */
        }
      }
    },
  },
  codegraph_verify: {
    description:
      "Return ONE compact PASS/FAIL verdict for the affected tests over the FULL working-tree diff " +
      "(memoized + sticky-PASS: unchanged green suites are skipped, so this is cheap). A PASS here means " +
      "the WHOLE change is green. Use this ONCE after editing; do not re-run the full suite repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        types: { type: "boolean", description: "Also run a scoped tsc --noEmit." },
        projectRoot: { type: "string" },
      },
    },
    run: a =>
      // Always verify the full git diff (no explicit file list) so a PASS is GLOBAL, never a
      // scoped-subset false PASS that would wrongly trip the PASS-latch.
      runScript(rootFrom(a), "verify-affected.cjs", [...(a.types ? ["--types"] : [])]),
  },
  codegraph_test_one: {
    description:
      "RAW-OUTPUT escape hatch: run ONE test file (optionally filtered by test name) and return the test runner's " +
      "FULL output. codegraph_verify is compact by design; reach for THIS only when a failure is genuinely " +
      "gnarly — a big received object, a parameterized test.each where you must see every case's actual " +
      "value, or an error whose cause is buried. Pass a test file (or a source file whose covering test to " +
      "run) and optionally a name filter. Do NOT use this as your default check — it is token-heavy.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Test file to run (or a source file -> its covering test)." },
        name: { type: "string", description: "Optional -t test-name substring to run just that case." },
        projectRoot: { type: "string" },
      },
      required: ["file"],
    },
    run: a =>
      runScript(rootFrom(a), "test-one.cjs", [a.file, ...(a.name ? ["-t", a.name] : [])]),
  },
};

// ---------- JSON-RPC plumbing ----------
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyErr(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "codegraph-mcp", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no response
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS[name];
    if (!tool) return replyErr(id, -32602, `unknown tool: ${name}`);
    try {
      const _root = rootFrom(args);
      // ---- Fix E: activate this root's OWN state, then apply the idle-gap task boundary ----
      // Must run before every gate below, so budgets/latch are always read from the right root.
      activateRoot(path.resolve(_root));
      const _now = Date.now();
      if (lastCallAt && _now - lastCallAt > TASK_IDLE_MS) {
        // A quiet gap this long means the previous task ended (a runaway loop never pauses), so the
        // budget starts fresh. This is what stops CALL_BUDGET degrading into a session countdown for
        // discovery-only runs, which never arm the edit-based reset below.
        process.stderr.write(`[codegraph] task boundary: ${Math.round((_now - lastCallAt) / 1000)}s idle on ${_root} \u2014 resetting run state\n`);
        resetRunState();
        runRoot = path.resolve(_root); // keep the pin we just resolved; only budgets/latch reset
      }
      lastCallAt = _now;
      // ---- ORCHESTRATOR-ONLY reset (no agent-callable tool) ----
      // The subagent must NOT be able to zero its own budgets/latch (it will do so to escape a
      // READ/LOCATE budget and keep spiralling). So reset is out-of-band: the ORCHESTRATOR (which
      // has shell access; the KG agents do not) drops a flag file at <root>/.codegraph/.cg-reset
      // before re-invoking. We consume it on the next call — clearing state exactly once, at the
      // start of the new run — then delete the flag. No process kill, no ClosedResourceError.
      try {
        const flag = path.join(_root, ".codegraph", ".cg-reset");
        if (fs.existsSync(flag)) {
          resetRunState();
          fs.unlinkSync(flag);
        }
      } catch (_) { /* best-effort; never fail a call over the reset flag */ }
      // ---- fail-fast setup check (soft): missing scripts/DB -> ONE actionable line, never a crash ----
      const setupErr = preflight(_root);
      if (setupErr) {
        return reply(id, { content: [{ type: "text", text: setupErr }], isError: false });
      }
      // ---- per-run state reset (server is long-lived across runs; don't leak the latch/budgets) ----
      if (resetArmed && treeClean(_root)) resetRunState();
      // ---- TURN-CUTTER gates (mechanical; the model can't opt out) ----
      // NOTE: callCount is incremented ONLY when a tool actually EXECUTES (just before tool.run),
      // so server interventions below (latch / budget / defer / dedup rejects) don't burn budget.
      if (passed && name === "codegraph_verify") {
        // PASS-latch (verify-scoped): re-verifying an already-green tree is pure waste. This latch is
        // CLEARED the moment a NEW edit lands (see EDIT_TOOLS block below), so a subsequent task on this
        // long-lived, sub-agent-shared server starts fresh. It must NOT block locate/read/apply — those
        // are the legitimate first moves of the next task (this over-broad block previously wedged the
        // whole tool surface across tasks once any verify went green).
        return reply(id, {
          content: [{ type: "text", text:
            `ALREADY GREEN — the affected tests PASS and nothing changed since. Do NOT verify again; emit your FINAL ANSWER now (list the files you changed).` }],
          isError: false,
        });
      }
      if (callCount >= CALL_BUDGET) {
        return reply(id, {
          content: [{ type: "text", text:
            `CALL BUDGET EXHAUSTED (${CALL_BUDGET} productive tool calls). Stop calling tools and finalize: write your FINAL ANSWER from what you already have. If tests were last PASS you're done; otherwise make only the single minimal remaining edit, then finalize.` }],
          isError: false,
        });
      }
      if (name === "codegraph_verify") {
        if (verifyRuns >= VERIFY_BUDGET) {
          return reply(id, {
            content: [{ type: "text", text:
              `VERIFY BUDGET EXHAUSTED (${VERIFY_BUDGET} runs). Do not verify again. If the last verdict was PASS, finalize; otherwise fix ONLY the named failing assertions, then finalize.` }],
            isError: false,
          });
        }
        const unedited = [...plannedDefFiles].filter(f => !editedFiles.has(f));
        if (plannedDefFiles.size && unedited.length && deferCount < DEFER_CAP) {
          deferCount += 1;
          return reply(id, {
            content: [{ type: "text", text:
              `VERIFY DEFERRED — ${unedited.length} of ${plannedDefFiles.size} planned definition site(s) still unedited: ${unedited.join(", ")}. Make those edits first (codegraph_apply_edit_at_site), THEN verify ONCE.` }],
            isError: false,
          });
        }
      }
      // ---- codegraph_locate gate: cap the discovery search-spiral ----
      if (name === "codegraph_locate" && locateRuns >= LOCATE_BUDGET) {
        const hint = bestCandidate
          ? ` Your strongest hit so far is ${bestCandidate.name} (${bestCandidate.loc}) — hand THAT to codegraph_plan, or edit it directly.`
          : "";
        return reply(id, { content: [{ type: "text", text:
          `LOCATE BUDGET EXHAUSTED (${LOCATE_BUDGET} searches). You already have enough to act — STOP searching.` +
          hint +
          ` The symbol you want almost certainly lives in a SHARED helper (a shared config/util module), NOT a feature-local ` +
          `constant — re-searching with the feature name won't surface a new answer. Go to codegraph_plan / ` +
          `codegraph_trace(entry=<a symbol you already found>) / codegraph_apply_edit_at_site now.` }], isError: false });
      }
      // ---- codegraph_read gates: budget (B) + subsuming/overlap reject (A,C) + batch nudge (D) ----
      if (name === "codegraph_read") {
        const rangeParts = parseReadTargets(args.targets).filter(p => p.lo != null);
        // B: hard cap on real read executions
        if (readRuns >= READ_BUDGET) {
          return reply(id, { content: [{ type: "text", text:
            `READ BUDGET EXHAUSTED (${READ_BUDGET} reads). You have more than enough context — STOP reading and EDIT now ` +
            `with codegraph_apply_edit_at_site (it fetches its own context + verifies). ` }], isError: false });
        }
        // A + C: reject if every requested range is already covered (contained) OR mostly seen (>=overlap)
        if (rangeParts.length && rangeParts.every(p => isCovered(p.file, p.lo, p.hi) || coveredFraction(p.file, p.lo, p.hi) >= OVERLAP_REJECT)) {
          const where = rangeParts.map(p => `${p.file}:${p.lo}-${p.hi}`).join(", ");
          return reply(id, { content: [{ type: "text", text:
            `DUPLICATE READ REJECTED — you already have ${where} (it was shown by an earlier read/plan/locate), so that code ` +
            `is already in your context above. Do NOT re-read. Proceed to EDIT (codegraph_apply_edit_at_site) or run codegraph_verify.` }],
            isError: false });
        }
        // D: force batching — refuse a streak of single-target reads
        if (rangeParts.length <= 1) {
          singleStreak += 1;
          if (singleStreak > SINGLE_STREAK_CAP) {
            return reply(id, { content: [{ type: "text", text:
              `BATCH YOUR READS — you've made ${singleStreak} single-target reads in a row. Combine ALL remaining ` +
              `targets you need into ONE codegraph_read call (targets:['a.ts:10-40','b.tsx:5',...]), or just EDIT with ` +
              `codegraph_apply_edit_at_site using what you already have.` }], isError: false });
          }
        } else {
          singleStreak = 0; // a real batch resets the streak
        }
      }
      const { ok, text } = tool.run(args);
      callCount += 1; // only a REAL execution burns budget (gates above returned without counting)
      if (name === "codegraph_read") {
        // Only a PRODUCTIVE read (returned real content) marks ranges served + burns read budget.
        // A failed/empty read ("no matches", "(no output)", non-zero exit) must NOT record served
        // ranges — otherwise a silently-failed read permanently locks the agent out of that file
        // via a later DUPLICATE-READ reject, and shouldn't count against the "you've read enough" cap.
        const productive = ok && !/\(no matches for|\(no output\)/i.test(text);
        if (productive) { recordServed(args.targets); readRuns += 1; }
      }
      if (["codegraph_plan", "codegraph_locate", "codegraph_impact"].includes(name)) recordHydratedFromOutput(text); // A
      if (name === "codegraph_locate") {
        locateRuns += 1;
        const c = captureBestCandidate(text);
        if (c && (c.strong || !bestCandidate)) bestCandidate = c; // keep earliest hit; upgrade to any STRONG
      }
      // MEMO/DEDUP: for read-only tools, reject an exact repeat that changed nothing.
      if (DEDUP_READ.has(name)) {
        const key = memoKey(name, args);
        const hash = crypto.createHash("md5").update(text).digest("hex");
        const prev = memo.get(key);
        if (prev && prev.hash === hash) {
          prev.count += 1;
          const msg =
            `DUPLICATE CALL REJECTED — you already ran \`${name}\` with these exact args (this is call #${prev.count}) ` +
            `and NOTHING has changed since, so the result is identical to what is already in your context above. ` +
            `Do NOT re-read the same thing. Proceed: make your EDIT (codegraph_apply_edit_at_site / codegraph_apply_literal / codegraph_apply) ` +
            `using the data you already have, or if all edits are done, run codegraph_verify ONCE.`;
          return reply(id, { content: [{ type: "text", text: msg }], isError: false });
        }
        memo.set(key, { hash, count: 1 });
      }
      if (EDIT_TOOLS.has(name)) {
        passed = false; // a NEW edit invalidates any prior green verdict — including a STALE PASS latched
                        // by a previous task on this long-lived server. This edit's own verdict is
                        // (re)set from its output below, so a failing new edit can never inherit an old PASS.
        memo.clear(); // edits invalidate prior reads + reset dup counters
        servedRanges.clear();
        collectEdited(args, text); // track which planned sites are now edited (for g3)
        resetArmed = true; // tree is now dirty; arm the per-run reset for the NEXT run (after restore)
      }
      if (name === "codegraph_plan") collectPlannedDefs(text); // remember the sites plan told it to edit
      if (name === "codegraph_verify") verifyRuns += 1; // only EXPLICIT verifies count against budget
      // PASS-latch: any tool output carrying a PASS verdict (explicit verify OR the fused
      // apply_edit_at_site --verify) means tests are green -> disable further tools.
      if (/\bverdict:\s*PASS\b/i.test(text)) passed = true;
      // A test/type VERDICT (PASS or FAIL) is INFORMATION the agent must read and act on —
      // NOT a tool execution error. Returning isError:true on a legitimate FAIL makes some hosts
      // (e.g. pydantic-ai based ones) turn the hard tool error into a retry and crash the run at
      // max_retries instead of letting the agent fix the failing tests. So: if the
      // output carries a 'verdict: PASS|FAIL' line, never flag it as an error (the text speaks
      // for itself). Only genuine failures with no verdict (script crash, bad anchor, missing
      // projectRoot) keep isError:true so the model still gets a real retry signal.
      const hasVerdict = /\bverdict:\s*(PASS|FAIL)\b/i.test(text);
      // Trace dead-ends at JSX/prop boundaries (the graph doesn't track prop wiring). Instead of an
      // empty result the model can't act on, teach it the known escape hatch: trace from the shared
      // component's CONFIG symbol, or locate the concept directly in the shared config module.
      let outText = text;
      if (name === "codegraph_trace" && (!ok || /\bno\b.*(chain|result|path|reach)/i.test(text) || text === "(no output)")) {
        outText =
          text +
          "\n\nHINT: a trace can dead-end when the value flows through a JSX/component PROP (the graph " +
          "doesn't track prop wiring). Try one of: (1) trace from the SHARED component's config/among " +
          "config symbol from the shared module instead of the caller; (2) codegraph_locate the concept directly; " +
          "(3) if you already know the file, codegraph_read the render site. Do NOT keep re-tracing the same entry.";
      }
      // Bare-path read (no line range) can't be hydrated and returns nothing — the agent wastes a
      // call and may loop. Teach it to get a file:line from locate/plan first, then read the range.
      if (name === "codegraph_read") {
        const bare = parseReadTargets(args.targets).filter(p => p.lo == null).map(p => p.file);
        const unproductive = !ok || /\(no matches for|\(no output\)/i.test(text);
        if (bare.length && unproductive) {
          outText =
            text +
            `\n\nHINT: codegraph_read needs a LINE RANGE ('file:start-end') or a single line ('file:line') — ` +
            `a bare path like '${bare[0]}' can't be hydrated. First run codegraph_locate or codegraph_plan ` +
            `to get the symbol's file:line, THEN read that exact range (batch all ranges into one call).`;
        }
      }
      // Discovery tools (SOFT_TOOLS) must NEVER return isError:true — some hosts (e.g. pydantic-ai
      // based ones) turn a hard tool error into a retry and crash the run at max_retries. Their
      // text is guidance; let it speak.
      const softFail = SOFT_TOOLS.has(name);
      return reply(id, { content: [{ type: "text", text: outText }], isError: hasVerdict || softFail ? false : !ok });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) replyErr(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      if (msg && msg.id !== undefined) replyErr(msg.id, -32603, `internal: ${e.message}`);
    }
  }
});
// exit only after queued replies flush — process.exit() truncates piped stdout (seen on Node 20)
process.stdin.on("end", () => process.stdout.write("", () => process.exit(0)));
