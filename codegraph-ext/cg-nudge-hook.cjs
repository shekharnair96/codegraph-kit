#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/cg-nudge-hook.cjs — a path-aware UserPromptSubmit *nudge* hook.
 *
 * When (and ONLY when) the session cwd is inside this microapp, it injects a
 * one-line reminder to reach for `cg:ask` (the codegraph-ext overlay) before
 * grep + whole-file reads for who-tests/mocks/props/docs discovery.
 *
 * It is a NUDGE, never a block — it can never stop a prompt or a tool call.
 * Contract (mirrors ~/.wibey/hooks/session-memory.py):
 *   - receives JSON on stdin: { session_id, cwd, ... }
 *   - stdout (exit 0) is injected into the model context
 *   - any error → exit 0 with no output (fail-safe)
 *   - fires ONCE per session (cheap) via a marker file
 *
 * Registered into ~/.wibey/hooks/hooks.json by install-hook.cjs. Not committed
 * anywhere global — the repo ships the script; each user opts in via the installer.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// The path segment that scopes this hook. Override with CG_NUDGE_MARKER.
const MARKER = process.env.CG_NUDGE_MARKER || "microapps/analytics";
const CACHE = path.join(os.homedir(), ".wibey", ".cache", "cg-nudge");

const NUDGE = [
  " codegraph-ext is available in this repo — prefer it over grep+full-file reads for code navigation.",
  '  • BEFORE editing a symbol → `npm run cg:plan -- <Symbol> "<change>"` gives the pre-scoped edit set (def + refs + covering tests + literal-assert sites). Plan once, then edit — don\'t hunt turn-by-turn.',
  "  • full change set for a symbol → `npm run cg:ask -- impact <Symbol>`",
  "  • who tests / who mocks a module → `npm run cg:ask -- covers <path>` / `-- mocks <path>` (returns the mocked exports too)",
  "  • a component's props / a symbol's signature+doc → `npm run cg:ask -- props <Name>` / `-- docs <Name>`",
  "  • dedupe classifications & durable decisions → `npm run cg:ask -- dedupe [filter]` / `-- notes [term]`",
  "  • verify ONCE at the end (only affected tests) → `npm run cg:test` (infers changed files) or `-- <file>`",
  "  • one compact PASS/FAIL verdict (deduped failures) → `npm run cg:verify` (add `-- --types` for a scoped tsc)",
  '  • apply many anchored edits across files in one atomic call → `npm run cg:apply -- edits.json` (all-or-nothing); get a skeleton via `npm run cg:plan -- <Symbol> "<change>" --spec`',
  "  • read only the relevant slices of many files at once → `npm run cg:read -- <file:line …>` or `-- <Symbol>`",
  "  Suggestions, not rules: prefer anchored replace_in_file over whole-file rewrites; don't re-read files already in context.",
  "  One cheap call beats a multi-turn grep loop (measured ~18–60× fewer tokens on discovery).",
  "  Caveat: impact refs/asserts are high-recall heuristics — trust the definition, verify the rest; for RESOLVED prop *types* or *transitive* coverage, still read the files.",
].join("\n");

function main() {
  let data = {};
  try {
    const raw = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    /* fall through with empty data */
  }
  const cwd = data.cwd || process.cwd();
  if (!cwd.includes(MARKER)) return; // not our folder → silent

  const sid = String(data.session_id || "");
  try {
    fs.mkdirSync(CACHE, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const marker = sid ? path.join(CACHE, sid) : null;
  if (marker && fs.existsSync(marker)) return; // already nudged this session
  try {
    if (marker) fs.writeFileSync(marker, "1");
  } catch (_) {
    /* ignore */
  }

  process.stdout.write(NUDGE + "\n");
}

try {
  main();
} catch (_) {
  /* fail-safe: never block a prompt */
}
process.exit(0);
