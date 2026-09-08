/* The test-runner adapter: which runner cg:verify / cg:test-one invoke, and whether the report
 * they get back is one they can actually read.
 *
 * jest and vitest differ in exactly one flag (`--json` vs `--reporter=json`); everything else is
 * shared because vitest's json reporter emits jest's result schema. That's a promise about someone
 * else's output format, so it is pinned here against a REAL vitest report — test-fixture/reports/
 * vitest-report.json, captured from `npx vitest run --reporter=json` on a two-test file (one pass,
 * one fail) with the absolute paths rewritten to /REPO. If vitest ever drifts from jest's shape,
 * this fails instead of cg:verify silently reporting "no parseable result".
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "codegraph-ext");
const CFG = path.join(EXT, "verify.config.json");
const AFFECTED = path.join(EXT, "affected.cjs");

// affected.cjs reads verify.config.json at call time but caches nothing, so swapping the file and
// re-requiring is enough. Restore whatever was there (usually nothing) no matter how we exit.
function withRunner(runner, fn) {
  const had = fs.existsSync(CFG);
  const prev = had ? fs.readFileSync(CFG, "utf8") : null;
  try {
    if (runner) fs.writeFileSync(CFG, JSON.stringify({ runner }));
    else if (had) fs.unlinkSync(CFG);
    delete require.cache[require.resolve(AFFECTED)];
    return fn(require(AFFECTED));
  } finally {
    if (had) fs.writeFileSync(CFG, prev);
    else if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
    delete require.cache[require.resolve(AFFECTED)];
  }
}

test("the runner is jest by default and vitest when configured, with the right report flag", () => {
  withRunner(null, a => {
    assert.strictEqual(a.runnerFamily(), "jest");
    assert.deepStrictEqual(a.jsonReportArgs("/tmp/o.json"), ["--json", "--outputFile=/tmp/o.json"]);
  });

  // A repo overriding the runner still gets its fixed args placed before ours.
  withRunner(["jest", "--config", "jest.unit.config.js"], a => {
    assert.strictEqual(a.runnerFamily(), "jest");
    assert.deepStrictEqual(a.runnerArgs(a.jsonReportArgs("/tmp/o.json")).args, [
      "jest",
      "--config",
      "jest.unit.config.js",
      "--json",
      "--outputFile=/tmp/o.json",
    ]);
  });

  withRunner(["vitest", "run"], a => {
    assert.strictEqual(a.runnerFamily(), "vitest");
    assert.deepStrictEqual(a.runnerArgs(a.jsonReportArgs("/tmp/o.json")).args, [
      "vitest",
      "run",
      "--reporter=json",
      "--outputFile=/tmp/o.json",
    ]);
  });

  // Detection is on the binary's basename, so a path or a wrapper name still resolves.
  withRunner(["./node_modules/.bin/vitest", "run"], a =>
    assert.strictEqual(a.runnerFamily(), "vitest")
  );
});

test("a real vitest report carries every field cg:verify reads", () => {
  const r = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "test-fixture", "reports", "vitest-report.json"), "utf8")
  );

  // The headline counts verify-affected.cjs turns into the PASS/FAIL line.
  assert.strictEqual(typeof r.success, "boolean");
  assert.strictEqual(r.numTotalTests, 2);
  assert.strictEqual(r.numPassedTests, 1);
  assert.strictEqual(r.numFailedTests, 1);

  // Per-suite: `name` must be an absolute path (it gets path.relative'd against APP_ROOT) and each
  // assertion must carry a `status`, or the sticky-PASS cache would record garbage.
  const suite = r.testResults[0];
  assert.ok(path.posix.isAbsolute(suite.name), `suite.name is not absolute: ${suite.name}`);
  assert.ok(Array.isArray(suite.assertionResults) && suite.assertionResults.length === 2);
  suite.assertionResults.forEach(t => assert.ok(typeof t.status === "string"));

  const failed = suite.assertionResults.find(t => t.status === "failed");
  assert.ok(failed, "the fixture report must contain a failing assertion");

  // The hydrated failure line: "<ancestors> > <title>" then the first message line.
  const name = [...(failed.ancestorTitles || []), failed.title].join(" > ");
  assert.strictEqual(name, "group > fails");

  const fm = failed.failureMessages && failed.failureMessages[0];
  assert.ok(fm, "vitest must put the failure text in failureMessages[0]");
  const msgLines = fm.split("\n").map(s => s.trim());
  const firstMsg = msgLines.find(s => /^(expect|Error|AssertionError|Received|Expected)/.test(s));
  // Without AssertionError in that alternation this is undefined and the model is told
  // "(see full runner output)" instead of the actual reason.
  assert.strictEqual(firstMsg, "AssertionError: expected 1 to be 2 // Object.is equality");

  // assertLine(): the first stack frame pointing back into the test file gives the edit site that
  // codegraph_apply_edit_at_site is handed. Without it the failure has no file:line to act on.
  const base = path.basename(suite.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(base + ":(\\d+):\\d+");
  const ln = msgLines.map(l => l.match(re)).find(Boolean);
  assert.ok(ln, "no stack frame points back into the test file");
  assert.strictEqual(parseInt(ln[1], 10), 4);
});

test("a suite that fails to LOAD is a FAIL verdict, not a silent PASS", () => {
  const { suiteRanOk, testReportVerdict } = require(path.join(__dirname, "..", "codegraph-ext", "affected.cjs"));

  // Captured from a real `npx jest --json` run on a file with a syntax error, paths rewritten to
  // /REPO. The shape is the whole point: jest reports the crash with numTotalTests: 0 AND
  // numFailedTests: 0, so counting failed assertions alone scored it green. cg:verify printed
  // "tests: FAIL (0/0 passed, 0 failed)" directly above "verdict: PASS", and the MCP layer latched
  // that PASS for the remainder of the task - an agent could ship a red tree believing it green.
  const r = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "test-fixture", "reports", "jest-suite-load-failure.json"), "utf8")
  );

  // Pin the trap itself: if these ever stop holding, this test is no longer covering the bug.
  assert.strictEqual(r.numTotalTests, 0);
  assert.strictEqual(r.numFailedTests, 0);
  assert.strictEqual(r.testResults[0].assertionResults.length, 0);

  const v = testReportVerdict(r);
  assert.strictEqual(v.ok, false, "a suite that never executed must not produce a PASS verdict");
  assert.strictEqual(v.crashed.length, 1);
  assert.ok(/Test suite failed to run/.test(v.crashed[0].message));

  // jest puts the suite-level error in `message` with status "failed"; `testExecError` and
  // `failureMessage` exist only on jest's in-process object, never in the JSON. Reading only those
  // was the first attempt at this fix and it silently did nothing.
  assert.strictEqual(r.testResults[0].testExecError, undefined);
  assert.strictEqual(r.testResults[0].failureMessage, undefined);
  assert.strictEqual(suiteRanOk(r.testResults[0]), false);

  // A genuinely green report must still pass, and a suite with assertions must still count as run.
  const green = { success: true, numFailedTests: 0, testResults: [{ name: "/REPO/a.test.ts", status: "passed", assertionResults: [{ status: "passed" }] }] };
  assert.strictEqual(testReportVerdict(green).ok, true);
  assert.strictEqual(suiteRanOk(green.testResults[0]), true);

  // A failing assertion is a FAIL but NOT a crash - it has an actionable file:line, so it must not
  // be routed through the "suite failed to run" branch.
  const red = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "test-fixture", "reports", "vitest-report.json"), "utf8")
  );
  const rv = testReportVerdict(red);
  assert.strictEqual(rv.ok, false);
  assert.strictEqual(rv.crashed.length, 0);
});
