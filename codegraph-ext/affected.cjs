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
function readVerifyCache() {
  try {
    return JSON.parse(fs.readFileSync(VERIFY_CACHE, "utf8"));
  } catch (_) {
    return {};
  }
}
function writeVerifyCache(obj) {
  try {
    fs.mkdirSync(path.dirname(VERIFY_CACHE), { recursive: true });
    fs.writeFileSync(VERIFY_CACHE, JSON.stringify(obj));
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
  readVerifyCache,
  writeVerifyCache,
  spawnSync,
  fs,
  path,
};
