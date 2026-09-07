#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/test-affected.cjs  (npm run cg:test)
 *
 * Maps changed SOURCE files -> the test files that cover them (via the `covers` overlay), then runs
 * ONLY those tests. Makes "verify only the affected test, once" the easy path, not a rule to
 * remember. A SUGGESTION-shaped convenience: it never blocks anything.
 *
 * Usage:
 *   npm run cg:test                        # infer changed files from `git diff` (working tree vs HEAD)
 *   npm run cg:test -- src/a.ts src/b.tsx  # explicit changed files
 *   npm run cg:test -- --dry               # print the mapping, don't run the tests
 */
const {
  inferChangedFromGit,
  resolveAffectedTests,
  runnerArgs,
  spawnSync,
  APP_ROOT,
} = require("./affected.cjs");

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
let changed = argv.filter(a => !a.startsWith("--"));
if (!changed.length) changed = inferChangedFromGit();

if (!changed.length) {
  console.log("[cg:test] no changed .ts/.tsx files detected (pass files explicitly, or make an edit).");
  process.exit(0);
}

let mapping, testList;
try {
  ({ mapping, testList } = resolveAffectedTests(changed));
} catch (e) {
  console.error(`[cg:test] ${e.message}`);
  process.exit(1);
}

console.log("\n[cg:test] changed -> covering test(s):");
mapping.forEach(m => {
  console.log(`  ${m.src}`);
  m.tests.forEach(t => console.log(`      -> ${t}`));
});

if (!testList.length) {
  console.log("\n[cg:test] no covering tests to run.");
  process.exit(0);
}
if (dry) {
  console.log(`\n[cg:test] --dry: would run the tests on ${testList.length} file(s).`);
  process.exit(0);
}

console.log(`\n[cg:test] running the tests on ${testList.length} file(s)…\n`);
const { args } = runnerArgs(["--", ...testList]);
const res = spawnSync("npx", args, { cwd: APP_ROOT, stdio: "inherit" });
process.exit(res.status == null ? 1 : res.status);
