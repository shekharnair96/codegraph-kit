#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/test-one.cjs  (codegraph_test_one)
 *
 * The RAW-OUTPUT escape hatch. `codegraph_verify` is deliberately COMPACT (one verdict + hydrated
 * fail sites) to save tokens. When a failure is genuinely gnarly — a big received object, a
 * parameterized test.each where you need to see every case's actual value, an error whose real cause
 * is buried — ask for the firehose HERE, and ONLY here, ONLY when you need it. Runs ONE test file
 * (optionally filtered by test name) and returns the runner's full stdout/stderr.
 *
 * Usage:
 *   node test-one.cjs <testFileOrSourceFile> [-t "test name substring"]
 *   - if given a SOURCE file, it resolves the covering test file(s) via the graph and runs them.
 *   - -t / --name filters to matching test names, so you get just the case you care about
 *     (`-t` is spelled the same in jest and vitest).
 */
const {
  resolveAffectedTests,
  runnerArgs,
  spawnSync,
  APP_ROOT,
  isTest,
} = require("./affected.cjs");

const argv = process.argv.slice(2);
const nameIdx = argv.findIndex(a => a === "-t" || a === "--name");
let nameFilter = null;
if (nameIdx !== -1) {
  nameFilter = argv[nameIdx + 1] || null;
  argv.splice(nameIdx, 2);
}
const target = argv.find(a => !a.startsWith("--"));
if (!target) {
  console.error("[cg:test-one] need a test file (or a source file whose covering test to run).");
  process.exit(1);
}

// Resolve to concrete test file(s): if it's already a test, run it; else map source -> covering tests.
let testFiles;
if (isTest(target)) {
  testFiles = [target];
} else {
  try {
    ({ testList: testFiles } = resolveAffectedTests([target]));
  } catch (e) {
    console.error(`[cg:test-one] ${e.message}`);
    process.exit(1);
  }
}
if (!testFiles || !testFiles.length) {
  console.log(`[cg:test-one] no test file resolved for '${target}'.`);
  process.exit(0);
}
const extra = ["--"];
if (nameFilter) extra.unshift("-t", nameFilter);
const { args } = runnerArgs([...extra, ...testFiles]);
console.log(
  `[cg:test-one] running FULL runner output for ${testFiles.length} file(s)` +
    `${nameFilter ? ` matching «${nameFilter}»` : ""}:\n  ${testFiles.join("\n  ")}\n`
);
// stdio:inherit -> the model gets the runner's complete raw output (this is the point of this tool).
const res = spawnSync("npx", args, { cwd: APP_ROOT, stdio: "inherit" });
process.exit(res.status == null ? 1 : res.status);
