#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/affected.cjs — shared helpers for the edit-loop CLIs (cg:test, cg:verify).
 *
 * Keeps the change→covering-test mapping and the test-runner invocation in ONE place so cg:test
 * and cg:verify can't drift. Pure library: no side effects on require.
 */
const { execFileSync, spawnSync } = require("child_process");
const { sqliteBin } = require("./sqlite-bin.cjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APP_ROOT = path.join(__dirname, "..");
const DB = path.join(APP_ROOT, ".codegraph", "codegraph.db");
const isTest = f => /\.test\.tsx?$/.test(f);
const esc = s => String(s).replace(/'/g, "''");
const toRel = f => path.relative(APP_ROOT, path.resolve(APP_ROOT, f)).split(path.sep).join("/");

function q(sql) {
  const out = execFileSync(sqliteBin(), ["-json", DB, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

// Changed .ts/.tsx files from `git diff HEAD`, scoped to this app and returned app-relative.
function inferChangedFromGit() {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: APP_ROOT,
      encoding: "utf8",
    }).trim();
    const appPrefix = path.relative(top, APP_ROOT);
    return execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: APP_ROOT, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter(p => p.startsWith(appPrefix))
      .map(p => p.slice(appPrefix.length + 1))
      .filter(p => /\.(ts|tsx)$/.test(p));
  } catch (_) {
    return [];
  }
}

// changed source/test files -> { mapping:[{src,tests[]}], testList:[realTestPaths] }
function resolveAffectedTests(changed) {
  if (!fs.existsSync(DB)) throw new Error(`no codegraph DB at ${DB} — run \`npm run cg:refresh\` first.`);
  const tests = new Set();
  const mapping = [];
  for (const raw of changed) {
    const rel = toRel(raw);
    if (isTest(rel)) {
      tests.add(rel);
      mapping.push({ src: rel, tests: ["(is a test — run directly)"] });
      continue;
    }
    const rows = q(
      `SELECT n.file_path AS test FROM edges e JOIN nodes n ON n.id=e.source ` +
        `WHERE e.kind='covers' AND e.provenance='ext' AND e.target='file:${esc(rel)}' ORDER BY 1;`
    );
    const covering = rows.map(r => r.test.replace(/^file:/, ""));
    covering.forEach(t => tests.add(t));
    mapping.push({ src: rel, tests: covering.length ? covering : ["(no covering test found)"] });
  }
  return { mapping, testList: [...tests].filter(t => !t.startsWith("(")) };
}

// Build the test-runner argv. Default is `npx jest <extra>`; a repo can override via
// codegraph-ext/verify.config.json:  { "runner": ["jest", "--config", "jest.unit.config.js"] }
// or                                 { "runner": ["vitest", "run"] }
// (the first element is the npx-resolved binary, the rest are fixed args placed before ours).
const VERIFY_CONFIG = path.join(__dirname, "verify.config.json");
function runnerConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(VERIFY_CONFIG, "utf8"));
    if (Array.isArray(cfg.runner) && cfg.runner.length) return cfg.runner.map(String);
  } catch (_) {
    /* no override */
  }
  return ["jest"];
}
function runnerArgs(extra = []) {
  const runner = runnerConfig();
  return { args: runner.concat(extra), useConfig: runner.length > 1 };
}

// jest and vitest differ in exactly one place that matters to us: how you ask for a machine-readable
// report. Everything downstream is shared, because vitest's json reporter deliberately emits jest's
// result schema — numPassedTests / numTotalTests / success / testResults[].assertionResults[] with
// status, ancestorTitles, title and failureMessages. The `-t` name filter is spelled the same way in
// both, and both accept `-- <file>...`, so no other call site needs to know which one is configured.
function runnerFamily() {
  const bin = path.basename(String(runnerConfig()[0] || "")).replace(/\.(?:[cm]?js)$/, "");
  return /vitest/i.test(bin) ? "vitest" : "jest";
}
function jsonReportArgs(outFile) {
  return runnerFamily() === "vitest"
    ? ["--reporter=json", `--outputFile=${outFile}`]
    : ["--json", `--outputFile=${outFile}`];
}

// ---------- verify memoization ----------
// Re-verifying without changing anything is the #1 waste (agents re-run the suite after every micro-edit).
// Fingerprint the exact inputs (changed files + covering tests, by content); if a prior run has the
// same fingerprint, the verdict is reusable with NO test run.
const VERIFY_CACHE = path.join(APP_ROOT, ".codegraph", "verify-cache.json");

// CACHE_SCHEMA — bump this INTEGER any time the MEANING of a cached verdict changes, i.e. any time
// testReportVerdict()/suiteRanOk() (above) change what counts as PASS/FAIL. A cache entry's `ok` bit
// is only trustworthy under the semantics that produced it; serving it after the semantics changed
// re-plays the old bug from a stale file.
//
// This constant exists because of exactly that: commit 6a01248 fixed a suite that fails to LOAD
// (syntax error, bad import, throw at module scope) being scored as a PASS — such a suite reports
// numTotalTests: 0 AND numFailedTests: 0, so counting failed assertions alone called it green. The
// fix changed how a fresh run computes `ok`, but did nothing about verdicts a PRE-fix run had already
// written to verify-cache.json — so every cached entry from before 6a01248 kept serving its old,
// wrong, green verdict forever (the whole-run cache never re-derives on a fingerprint hit, and the
// sticky per-suite cache is even stickier: an unrelated fix doesn't change the poisoned suite's own
// fingerprint, so it stays skipped indefinitely).
//
// readVerifyCache() discards the ENTIRE file whenever its stamp doesn't match this constant, so the
// fix is: bump CACHE_SCHEMA in the same commit that changes verdict semantics, and every existing
// cache — whole-run and sticky-suite alike — self-heals on the next run (one wasted test run, then
// clean). Do not reuse the reserved `__schema__` key for anything else; it can't collide with a real
// cache entry because those are keyed by a 32-char md5 fingerprint (optionally +"+types") or by
// `suite:<path>`.
const CACHE_SCHEMA = 2;
const SCHEMA_KEY = "__schema__";

function fileHash(rel) {
  try {
    return crypto
      .createHash("md5")
      .update(fs.readFileSync(path.resolve(APP_ROOT, rel)))
      .digest("hex");
  } catch (_) {
    return "MISSING";
  }
}
function fingerprint(files) {
  const h = crypto.createHash("md5");
  [...new Set(files)].sort().forEach(f => {
    h.update(f);
    h.update(fileHash(f));
  });
  return h.digest("hex");
}

// A whole-run cache entry ({ ok, block }) is self-inconsistent if it claims `ok: true` but its own
// rendered block reports a FAIL — e.g. a suite that failed to load, scored green by the pre-6a01248
// bug. That shape can only reach us from a cache the schema check above should already have dropped,
// but checking it directly is cheap, doesn't need a version bump to keep working, and is a second
// line of defense against any other path that could write a corrupt entry.
function isPoisonedEntry(v) {
  if (!v || typeof v !== "object") return true;
  if (typeof v.block === "string" && v.ok === true && /\b(verdict|tests):\s*FAIL\b/i.test(v.block)) {
    return true;
  }
  return false;
}

function readVerifyCache() {
  try {
    const obj = JSON.parse(fs.readFileSync(VERIFY_CACHE, "utf8"));
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj[SCHEMA_KEY] !== CACHE_SCHEMA) {
      return {}; // absent/legacy/malformed stamp -> discard the WHOLE file, don't trust any entry in it
    }
    const out = { [SCHEMA_KEY]: CACHE_SCHEMA };
    for (const [k, v] of Object.entries(obj)) {
      if (k === SCHEMA_KEY) continue;
      if (isPoisonedEntry(v)) continue; // corrupt entry: drop it, force a re-run for its key
      out[k] = v;
    }
    return out;
  } catch (_) {
    return {};
  }
}
function writeVerifyCache(obj) {
  try {
    fs.mkdirSync(path.dirname(VERIFY_CACHE), { recursive: true });
    fs.writeFileSync(VERIFY_CACHE, JSON.stringify({ ...obj, [SCHEMA_KEY]: CACHE_SCHEMA }));
  } catch (_) {
    /* best-effort */
  }
}

// ---------- per-suite sticky-PASS (gate 2) ----------
// A suite's fate depends ONLY on its own coverage set: the test file + the source files it covers.
// So we fingerprint exactly that. Once a suite is PASS under a given fingerprint it STAYS pass until
// a file in its coverage set changes — editing an unrelated file can't force it to re-run.
function coveredSources(testRel) {
  try {
    const rows = q(
      `SELECT DISTINCT e.target AS src FROM edges e JOIN nodes n ON n.id=e.source ` +
        `WHERE e.kind='covers' AND e.provenance='ext' AND n.file_path='${esc(testRel)}';`
    );
    return rows.map(r => String(r.src).replace(/^file:/, ""));
  } catch (_) {
    return [];
  }
}
function suiteFingerprint(testRel) {
  // hash the test file + every source file in its coverage set (by content)
  return fingerprint([testRel, ...coveredSources(testRel)]);
}

// ---------- reading the runner's report ----------
// A suite that fails to LOAD - syntax error, unresolvable import, a throw at module scope - never
// reaches an assertion, so it reports numTotalTests: 0 AND numFailedTests: 0. Deciding the verdict
// from failed-assertion counts alone therefore called it green, and the MCP layer latched that PASS
// for the rest of the task.
//
// In the serialized `--json` report a crashed suite is: zero assertionResults, plus a suite-level
// error. jest puts that error in `message` with `status: "failed"` (`testExecError` exists only on
// jest's in-process result object, never in the JSON); vitest's json reporter mirrors jest's schema.
// Both are checked, plus testExecError, so no runner shape slips through as a false green.
function suiteRanOk(suite) {
  if ((suite.assertionResults || []).length) return true; // it executed something
  // Zero assertions: either it crashed, or the file genuinely holds no tests - which jest also
  // reports as a failed suite with a message ("must contain at least one test"). Either way the
  // distinguishing signal is a suite-level error, not the assertion count.
  const msg = suite.message || suite.failureMessage || suite.testExecError || "";
  return !(suite.status === "failed" || String(msg).trim());
}

// The single source of truth for "did the test phase pass". Failed-assertion count alone misses
// crashes, and `success` alone has been unreliable across runner versions, so a green verdict
// requires all of: the runner is happy, nothing asserted false, and every suite actually ran.
function testReportVerdict(r) {
  const crashed = (r.testResults || []).filter(s => !suiteRanOk(s));
  const failed = r.numFailedTests || 0;
  const runtimeErrors = r.numRuntimeErrorTestSuites || 0;
  return {
    ok: !!r.success && failed === 0 && crashed.length === 0 && runtimeErrors === 0,
    failed,
    crashed,
  };
}

module.exports = {
  APP_ROOT,
  DB,
  q,
  esc,
  toRel,
  isTest,
  inferChangedFromGit,
  resolveAffectedTests,
  runnerArgs,
  runnerConfig,
  runnerFamily,
  jsonReportArgs,
  fingerprint,
  suiteFingerprint,
  coveredSources,
  suiteRanOk,
  testReportVerdict,
  readVerifyCache,
  writeVerifyCache,
  CACHE_SCHEMA,
  SCHEMA_KEY,
  VERIFY_CACHE,
  spawnSync,
  fs,
  path,
};
