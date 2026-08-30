#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/affected.cjs — shared helpers for the edit-loop CLIs (cg:test, cg:verify).
 *
 * Keeps the change→covering-test mapping, the xarc dev bootstrap, and the jest invocation in ONE
 * place so cg:test and cg:verify can't drift. Pure library: no side effects on require.
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APP_ROOT = path.join(__dirname, "..");
const DB = path.join(APP_ROOT, ".codegraph", "codegraph.db");
const isTest = f => /\.test\.tsx?$/.test(f);
const esc = s => String(s).replace(/'/g, "''");
const toRel = f => path.relative(APP_ROOT, path.resolve(APP_ROOT, f)).split(path.sep).join("/");

function q(sql) {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

// The Aurora jest config reads .etmp/xarc-options.json (created by `xrun setup-dev`). Without it the
// config throws and jest silently falls back to broken defaults. Create it once if missing.
function ensureXarcSetup() {
  if (fs.existsSync(path.join(APP_ROOT, ".etmp", "xarc-options.json"))) return;
  console.log("[cg] initializing xarc dev options (one-time `xrun setup-dev`)…");
  const r = spawnSync("npx", ["xrun", "setup-dev"], { cwd: APP_ROOT, stdio: "ignore" });
  if (r.status !== 0) console.log("[cg] warning: `xrun setup-dev` failed; jest may use defaults.");
}

// Build the jest argv that mirrors how the app runs tests (project config, coverage off).
function jestArgs(extra = []) {
  const useConfig = fs.existsSync(path.join(APP_ROOT, "jest.coverage.config.js"));
  const args = ["jest"];
  if (useConfig) args.push("--config", "jest.coverage.config.js", "--coverage=false");
  return { args: args.concat(extra), useConfig };
}

// ---------- verify memoization ----------
// Re-verifying without changing anything is the #1 waste (agents re-run jest after every micro-edit).
// Fingerprint the exact inputs (changed files + covering tests, by content); if a prior run has the
// same fingerprint, the verdict is reusable with NO jest run.
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
  ensureXarcSetup,
  jestArgs,
  fingerprint,
  suiteFingerprint,
  coveredSources,
  readVerifyCache,
  writeVerifyCache,
  spawnSync,
  fs,
  path,
};
