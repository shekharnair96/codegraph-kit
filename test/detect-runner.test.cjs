/* Deriving the test runner from the target repo's own `scripts.test`.
 *
 * The bug this guards: with no verify.config.json, affected.cjs falls back to `["jest"]`, so a repo
 * whose suite only runs under `jest --config ./scripts/jest/jest.config.js` had cg:verify judging a
 * DIFFERENT suite than the one `npm test` runs. Detection has to get three outcomes right — derive,
 * pass through unchanged, and refuse — and refusing loudly is as important as the other two,
 * because the alternative is defaulting to jest and being quietly wrong.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { detectRunner, writeConfig, configPath, tokenize, filterFlags } = require(
  path.join(__dirname, "..", "install", "detect-runner.cjs")
);

const det = (test_, scripts = {}) => detectRunner({ scripts: { ...scripts, test: test_ } });
const runnerOf = (...a) => {
  const r = det(...a);
  assert.ok(r && r.runner, `expected a runner, got ${JSON.stringify(r)}`);
  return r.runner;
};
const refusal = (...a) => {
  const r = det(...a);
  assert.ok(r && r.unsupported, `expected a refusal, got ${JSON.stringify(r)}`);
  return r.reason;
};

test("the three real repos this was written against", () => {
  // react-hook-form: the silently-wrong case. Dropping --config runs the wrong suite.
  assert.deepStrictEqual(runnerOf("jest --config ./scripts/jest/jest.config.js"), [
    "jest",
    "--config",
    "./scripts/jest/jest.config.js",
  ]);
  // react-hot-toast: accidentally fine today, but --runInBand is load-bearing for it.
  assert.deepStrictEqual(runnerOf("jest --runInBand"), ["jest", "--runInBand"]);
  // codegraph-kit's own package.json: node's test runner emits no jest-shaped report. Refuse.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const self = detectRunner(pkg);
  assert.ok(self.unsupported, "the kit's own `node --test` script must be refused, not guessed at");
  assert.match(self.reason, /node/);
  assert.strictEqual(self.script, pkg.scripts.test);
});

test("indirection: npm/pnpm/yarn/npx delegation is followed, cycles and depth are not", () => {
  assert.deepStrictEqual(runnerOf("npm run test:unit", { "test:unit": "jest --ci" }), ["jest", "--ci"]);
  assert.deepStrictEqual(
    runnerOf("pnpm test:ci", { "test:ci": "npm run test:unit", "test:unit": "jest --runInBand" }),
    ["jest", "--runInBand"]
  );
  assert.deepStrictEqual(runnerOf("yarn jest --runInBand"), ["jest", "--runInBand"]);
  assert.deepStrictEqual(runnerOf("npx jest -c a.js"), ["jest", "-c", "a.js"]);
  assert.deepStrictEqual(runnerOf("npx --no-install vitest run"), ["vitest", "run"]);
  assert.deepStrictEqual(runnerOf("pnpm exec jest"), ["jest"]);

  // A script that points at itself must terminate with a refusal, not spin.
  assert.match(refusal("npm run test"), /cycle/);
  assert.match(refusal("npm run a", { a: "npm run b", b: "npm run c", c: "jest" }), /delegates more than/);
  // Args carried across the hop still reach the parser.
  assert.deepStrictEqual(runnerOf("npm run unit -- --runInBand", { unit: "jest" }), ["jest", "--runInBand"]);
});

test("dropped flags take their value with them, in both = and space form", () => {
  // A dropped value-flag whose value is left behind becomes a bare positional, which jest reads as
  // a test path filter — so the run silently narrows to nothing. Both spellings, every flag.
  for (const [a, b] of [
    ["--reporter", "verbose"],
    ["--reporters", "default"],
    ["--outputFile", "out.json"],
    ["-t", "some name"],
    ["--testNamePattern", "^x"],
    ["--testPathPattern", "src/"],
  ]) {
    assert.deepStrictEqual(runnerOf(`jest ${a} ${b} --runInBand`), ["jest", "--runInBand"], `${a} <value>`);
    assert.deepStrictEqual(runnerOf(`jest ${a}=${b} --runInBand`), ["jest", "--runInBand"], `${a}=value`);
  }
  // No-value drops.
  for (const f of ["--watch", "--watchAll", "--coverage", "--silent", "--json", "--onlyChanged"]) {
    assert.deepStrictEqual(runnerOf(`jest ${f} --ci`), ["jest", "--ci"], f);
  }
  // Bare positionals are path filters; we supply the file list after `--`.
  assert.deepStrictEqual(runnerOf("jest src/components --ci"), ["jest", "--ci"]);
  assert.deepStrictEqual(runnerOf("jest --ci -- src/a.test.ts"), ["jest", "--ci"]);
});

test("--bail is dropped with its optional number, so no digit is left as a path filter", () => {
  // --bail truncates the report, so crashed suites go unlisted — it interacts directly with the
  // suite-load-failure verdict, which is why it is a drop and not a keep.
  assert.deepStrictEqual(runnerOf("jest --bail --ci"), ["jest", "--ci"]);
  assert.deepStrictEqual(runnerOf("jest --bail=1 --ci"), ["jest", "--ci"]);
  assert.deepStrictEqual(runnerOf("vitest run --bail 1 --ci"), ["vitest", "run", "--ci"]);
});

test("-w means different things in jest and vitest and must not strand its value", () => {
  // jest: -w is --maxWorkers and takes a value. vitest: -w is --watch and takes none. Treating
  // either as the other leaves a dangling `2`, or leaves the agent in a watch loop forever.
  assert.deepStrictEqual(runnerOf("jest -w 2"), ["jest", "-w", "2"]);
  assert.deepStrictEqual(runnerOf("jest --maxWorkers=50%"), ["jest", "--maxWorkers=50%"]);
  assert.deepStrictEqual(runnerOf("vitest -w"), ["vitest", "run"]);
});

test("kept flags: execution/config selectors survive, unknown flags keep their value", () => {
  assert.deepStrictEqual(runnerOf("jest --rootDir packages/core --no-cache --passWithNoTests"), [
    "jest",
    "--rootDir",
    "packages/core",
    "--no-cache",
    "--passWithNoTests",
  ]);
  // --projects is variadic: every bare token up to the next flag belongs to it.
  assert.deepStrictEqual(runnerOf("jest --projects a b c --ci"), ["jest", "--projects", "a", "b", "c", "--ci"]);
  // Unrecognized is kept, conservatively, along with its argument.
  assert.deepStrictEqual(runnerOf("jest --someRepoFlag value --ci"), ["jest", "--someRepoFlag", "value", "--ci"]);
});

test("vitest is normalized to `run`, because bare vitest is watch mode", () => {
  assert.deepStrictEqual(runnerOf("vitest"), ["vitest", "run"]);
  assert.deepStrictEqual(runnerOf("vitest run"), ["vitest", "run"]);
  assert.deepStrictEqual(runnerOf("vitest watch --config v.ts"), ["vitest", "run", "--config", "v.ts"]);
  // `run` is a positional and would otherwise be filtered out with the path filters — this is the
  // regression that would silently put cg:verify back into watch mode.
  assert.deepStrictEqual(runnerOf("vitest run --coverage"), ["vitest", "run"]);
  assert.match(refusal("vitest bench"), /not a plain test run/);
});

test("refusals: everything the schema cannot express, named specifically", () => {
  // The schema has no place for an env var, so stripping it would produce a runner that LOOKS right
  // and fails on every ESM repo. Refusing is the safe half of that trade.
  assert.match(refusal("NODE_OPTIONS=--experimental-vm-modules jest"), /NODE_OPTIONS/);
  assert.match(refusal("cross-env CI=true jest"), /CI/);
  assert.match(refusal("node --test test/*.cjs"), /shell syntax|node/);
  assert.match(refusal("node --test test/a.cjs"), /node/);
  assert.match(refusal("mocha --require ts-node/register"), /mocha/);
  assert.match(refusal("react-scripts test"), /react-scripts/);
  assert.match(refusal("turbo run test"), /turbo/);
  assert.match(refusal("npm-run-all lint test:unit"), /npm-run-all/);
  assert.match(refusal("jest && tsc --noEmit"), /shell syntax/);
  assert.match(refusal("npm run build && jest"), /shell syntax/);
  // A pass-through wrapper with no assignment is still just jest.
  assert.deepStrictEqual(runnerOf("cross-env jest --ci"), ["jest", "--ci"]);
});

test("no test script at all is null, not a refusal and not a guess", () => {
  assert.strictEqual(detectRunner({ scripts: { build: "tsc" } }), null);
  assert.strictEqual(detectRunner({ scripts: { test: "   " } }), null);
  assert.strictEqual(detectRunner({}), null);
  assert.strictEqual(detectRunner(null), null);
});

test("quotes are honoured and the tokenizer refuses shell syntax outright", () => {
  assert.deepStrictEqual(runnerOf('jest --config "my configs/jest.js"'), ["jest", "--config", "my configs/jest.js"]);
  assert.strictEqual(tokenize("jest | tee log"), null);
  assert.strictEqual(tokenize("jest --config $CFG"), null);
  assert.strictEqual(tokenize("jest 'unterminated"), null);
  assert.deepStrictEqual(filterFlags(["--ci", "path/"], "jest"), ["--ci"]);
});

test("an existing verify.config.json is the user's override and is never overwritten", () => {
  // Same rule as annotations.json: the repo's own file wins. install.sh's copy loop globs *.cjs
  // precisely so it cannot clobber this one, and `emit` is the only writer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-detect-"));
  try {
    fs.mkdirSync(path.join(dir, "codegraph-ext"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest --ci" } }));
    const mine = JSON.stringify({ runner: ["vitest", "run"] });
    fs.writeFileSync(configPath(dir), mine);

    const { spawnSync } = require("child_process");
    const cli = path.join(__dirname, "..", "install", "detect-runner.cjs");
    const res = spawnSync(process.execPath, [cli, "emit", "--target", dir], { encoding: "utf8" });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /already present/);
    assert.strictEqual(fs.readFileSync(configPath(dir), "utf8"), mine);

    // With no config, emit writes the derived one.
    fs.unlinkSync(configPath(dir));
    const res2 = spawnSync(process.execPath, [cli, "emit", "--target", dir], { encoding: "utf8" });
    assert.strictEqual(res2.status, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath(dir), "utf8")).runner, ["jest", "--ci"]);
    // No installed affected.cjs -> the probe reports that it could not run, and says so as a
    // SKIP. "we could not probe" must never be dressed up as "the derived runner is wrong".
    assert.match(res2.stdout, /probe skipped/);

    // The same distinction is what keeps `--check` honest: a repo whose deps simply aren't
    // installed is a [warn] and still READY; only a probe that actually ran and came back
    // unreadable is a [MISSING].
    const res3 = spawnSync(process.execPath, [cli, "check", "--target", dir], { encoding: "utf8" });
    assert.strictEqual(res3.status, 0, "an un-probeable repo must not be reported NOT READY");
    assert.match(res3.stdout, /\[warn\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeConfig round-trips through affected.cjs's own reader", () => {
  // The contract is not "a file exists" but "affected.cjs builds this argv", so assert it there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-detect-"));
  const EXT = path.join(__dirname, "..", "codegraph-ext");
  const CFG = path.join(EXT, "verify.config.json");
  const had = fs.existsSync(CFG);
  const prev = had ? fs.readFileSync(CFG, "utf8") : null;
  try {
    const runner = runnerOf("jest --config ./scripts/jest/jest.config.js");
    fs.mkdirSync(path.join(dir, "codegraph-ext"), { recursive: true });
    writeConfig(dir, runner);
    fs.copyFileSync(configPath(dir), CFG);
    delete require.cache[require.resolve(path.join(EXT, "affected.cjs"))];
    const a = require(path.join(EXT, "affected.cjs"));
    assert.strictEqual(a.runnerFamily(), "jest");
    assert.deepStrictEqual(a.runnerArgs(["--", "a.test.ts"]).args, [
      "jest",
      "--config",
      "./scripts/jest/jest.config.js",
      "--",
      "a.test.ts",
    ]);
  } finally {
    if (had) fs.writeFileSync(CFG, prev);
    else if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
    delete require.cache[require.resolve(path.join(EXT, "affected.cjs"))];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
