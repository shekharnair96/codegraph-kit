#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * install/detect-runner.cjs — derive codegraph-ext/verify.config.json from the target repo's
 * own `scripts.test`.
 *
 * Why this exists: affected.cjs falls back to `["jest"]` when there is no verify.config.json, and
 * the installer never wrote one. For a repo whose tests only run under a specific config —
 * `jest --config ./scripts/jest/jest.config.js` — the fallback runs a DIFFERENT suite than the one
 * the repo's own `npm test` runs, and cg:verify's verdict is about that other suite. That is a
 * silent wrongness, so the rule here is: derive it, prove it with one real run, and refuse loudly
 * when the repo's runner is something the schema cannot express.
 *
 * Pure functions + a thin CLI, same shape as install/hosts.cjs. Nothing runs on require.
 *
 * CLI:
 *   node install/detect-runner.cjs detect --target <abs>   # print the parsed result as JSON
 *   node install/detect-runner.cjs emit   --target <abs>   # write verify.config.json + probe it
 *   node install/detect-runner.cjs check  --target <abs>   # one [ok]/[MISSING] line, exit 1 if bad
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// ---------------------------------------------------------------- tokenizing

// Anything in here means the script is doing real shell work (`npm run build && jest`, a pipe, a
// subshell, a variable). We cannot model that in an argv array, so we refuse rather than parse the
// first half of it and pretend.
const SHELL_META = /[|&;<>(){}`$*?[\]#~!]/;

// Split a command line into argv, honouring quotes. Returns null if the line uses shell syntax.
function tokenize(cmd) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let quoted = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || quoted) tokens.push(cur);
      cur = "";
      quoted = false;
      continue;
    }
    if (SHELL_META.test(ch)) return null;
    cur += ch;
  }
  if (quote) return null; // unterminated
  if (cur || quoted) tokens.push(cur);
  return tokens;
}

const isEnvAssignment = t => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
const binName = t => path.basename(String(t)).replace(/\.(?:[cm]?js)$/, "");

// ---------------------------------------------------------------- indirection

// `scripts.test` is very often a pointer: `npm run test:unit`, `pnpm test:ci`, `yarn jest`.
// Follow at most MAX_HOPS of those, with a cycle guard, then parse whatever we land on.
const MAX_HOPS = 2;
const PKG_MANAGERS = new Set(["npm", "pnpm", "bun", "yarn"]);
const NPX_LIKE = new Set(["npx", "pnpx", "bunx"]);
// npx flags we can safely ignore; anything else (-p/--package) changes what binary runs, so bail.
const NPX_SAFE_FLAGS = new Set(["-y", "--yes", "--no-install", "--no", "--prefer-offline"]);

// One delegation step. Returns { script } to follow, { tokens } when this is the real command,
// or { bail } when the indirection is something we refuse to model.
function step(tokens, scripts) {
  const t = tokens.slice();
  // `npx jest ...` -> `jest ...`
  if (NPX_LIKE.has(binName(t[0]))) {
    t.shift();
    while (t.length && t[0].startsWith("-")) {
      if (!NPX_SAFE_FLAGS.has(t[0])) return { bail: `\`npx ${t[0]}\` selects the package to run` };
      t.shift();
    }
    return { tokens: t };
  }
  const head = binName(t[0]);
  if (!PKG_MANAGERS.has(head)) return { tokens: t };

  let rest = t.slice(1);
  // `pnpm exec jest` / `yarn exec jest` / `bun x jest` run a binary directly.
  if (rest[0] === "exec" || rest[0] === "x" || rest[0] === "dlx") return { tokens: rest.slice(1) };
  if (rest[0] === "run" || rest[0] === "run-script") rest = rest.slice(1);
  if (!rest.length) return { bail: `\`${head}\` with no script name` };

  const name = rest[0] === "t" && head === "npm" ? "test" : rest[0];
  const extra = rest.slice(1).filter(a => a !== "--");
  if (Object.prototype.hasOwnProperty.call(scripts, name)) return { script: name, extra };
  // `yarn jest --runInBand` / `pnpm jest`: not a script, so it's a binary in .bin.
  if (head !== "npm") return { tokens: rest };
  return { bail: `\`npm run ${name}\` refers to a script that does not exist` };
}

// scripts.test -> { tokens, from } | { bail, from }
function resolveScript(scripts) {
  const seen = new Set(["test"]);
  let text = scripts.test;
  let extraArgs = [];
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const tokens = tokenize(text);
    if (!tokens) return { bail: "the test script uses shell syntax (&&, a pipe, a variable, a glob)", from: text };
    if (!tokens.length) return { bail: "the test script is empty", from: text };
    const r = step(tokens, scripts);
    if (r.bail) return { bail: r.bail, from: text };
    if (r.tokens) return { tokens: r.tokens.concat(extraArgs), from: text };
    if (seen.has(r.script)) return { bail: `the test script delegates in a cycle (${r.script})`, from: text };
    seen.add(r.script);
    extraArgs = (r.extra || []).concat(extraArgs);
    text = scripts[r.script];
  }
  return { bail: `the test script delegates more than ${MAX_HOPS} times`, from: text };
}

// ---------------------------------------------------------------- flag policy

// Wrappers that pass their tail through untouched. cross-env is here ONLY for the degenerate
// `cross-env jest` form — the moment it carries an assignment we refuse, below, like any other
// env-dependent command.
const PASSTHROUGH = new Set(["cross-env", "cross-env-shell"]);
// Binaries that fan out into other commands, or are simply a different runner. Naming them buys a
// message that says what the repo actually uses instead of "unrecognized binary".
const KNOWN_OTHER = {
  "npm-run-all": "npm-run-all runs several scripts; point verify at the one that runs the tests",
  "run-s": "run-s runs several scripts; point verify at the one that runs the tests",
  "run-p": "run-p runs several scripts; point verify at the one that runs the tests",
  concurrently: "concurrently runs several commands at once",
  turbo: "turbo delegates to per-package test scripts",
  lerna: "lerna delegates to per-package test scripts",
  nx: "nx delegates to per-project test targets",
  node: "node's built-in test runner emits no jest-shaped JSON report",
  mocha: "mocha is not supported (its JSON report is a different schema)",
  ava: "ava is not supported (its JSON report is a different schema)",
  tap: "tap is not supported (its JSON report is a different schema)",
  jasmine: "jasmine is not supported (its JSON report is a different schema)",
  karma: "karma is not supported (its JSON report is a different schema)",
  "react-scripts": "react-scripts test wraps jest but ignores --config",
  playwright: "playwright is an e2e runner, not a unit-test runner",
  cypress: "cypress is an e2e runner, not a unit-test runner",
  vitest: null, // supported — listed so the table reads completely
  jest: null,
};

// The keep/drop table. The principle: KEEP anything that selects WHICH tests run or HOW they are
// executed, DROP anything that decides what gets REPORTED (we supply our own reporter) or which
// subset to run (we supply the file list after `--`), and keep anything unrecognized, because a
// repo-specific flag is far more likely to be load-bearing than harmful.
const DROP_NOARG = new Set([
  "--watch", "--watchAll",             // would hang the agent forever. The single most important row.
  "--coverage",                        // slow, and instruments every run for no benefit
  "-b",                                // jest's --bail alias; `--bail` itself is handled below
  "--silent",
  "--json",
  "--listTests",
  "--onlyChanged", "-o", "--changedSince", "--lastCommit", // we choose the file set ourselves
]);
const DROP_WITH_VALUE = new Set([
  "--outputFile", "--reporter", "--reporters", "--json-outputFile",
  "-t", "--testNamePattern", "--testPathPattern", "--testPathPatterns",
]);
const KEEP_NOARG = new Set([
  "--runInBand", "-i", "--no-cache", "--passWithNoTests", "--forceExit",
  "--detectOpenHandles", "--ci", "--injectGlobals", "--no-threads", "--threads",
]);
// Kept flags that consume the NEXT token when not written as --flag=value. Getting this list right
// is what keeps `--maxWorkers 2` from leaving a bare `2` that jest then treats as a path filter.
const KEEP_WITH_VALUE = new Set([
  "--config", "-c", "--rootDir", "--maxWorkers", "--shard", "--testEnvironment",
  "--moduleNameMapper", "--setupFiles", "--globalSetup", "--globalTeardown", "--dir",
]);
// Variadic: everything up to the next flag belongs to it.
const KEEP_VARIADIC = new Set(["--projects", "--selectProjects", "--roots"]);

const flagOf = t => (t.startsWith("-") ? t.split("=")[0] : null);
const hasInlineValue = t => t.includes("=");

// Two flags mean different things in the two families, and getting either wrong leaves a dangling
// argument that the runner then reads as a test path:
//   -w      jest: --maxWorkers (takes a value)      vitest: --watch (takes none)
//   --bail  jest: no value                          vitest: a number, optionally space-separated
function classify(flag, family) {
  if (flag === "-w") return family === "vitest" ? "drop" : "keep-value";
  if (flag === "--bail") return "drop-optional-number";
  if (DROP_NOARG.has(flag)) return "drop";
  if (DROP_WITH_VALUE.has(flag)) return "drop-value";
  if (KEEP_VARIADIC.has(flag)) return "keep-variadic";
  if (KEEP_NOARG.has(flag)) return "keep";
  if (KEEP_WITH_VALUE.has(flag)) return "keep-value";
  return "keep-unknown";
}

const takesNext = (rest, i) => i + 1 < rest.length && !rest[i + 1].startsWith("-") && rest[i + 1] !== "--";

// argv after the binary -> the args we keep, in order.
function filterFlags(rest, family) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--") break; // everything past `--` is a file list; ours replaces it
    const flag = flagOf(t);
    if (!flag) continue; // a bare positional is a path/name filter — we supply the file list
    const how = classify(flag, family);
    if (how === "drop") continue;
    if (how === "drop-value") {
      // Dropping the flag without its value would leave a dangling argument that the runner then
      // reads as a test path — the exact failure this table exists to prevent.
      if (!hasInlineValue(t)) i++;
      continue;
    }
    if (how === "drop-optional-number") {
      if (!hasInlineValue(t) && takesNext(rest, i) && /^\d+$/.test(rest[i + 1])) i++;
      continue;
    }
    out.push(t);
    if (hasInlineValue(t)) continue;
    if (how === "keep-variadic") {
      while (takesNext(rest, i)) out.push(rest[++i]);
      continue;
    }
    // Known value-takers consume one token. So do UNKNOWN flags: a repo-specific flag is more
    // likely to need its argument than the repo is to list test paths mid-script.
    if ((how === "keep-value" || how === "keep-unknown") && takesNext(rest, i)) out.push(rest[++i]);
  }
  return out;
}

// ---------------------------------------------------------------- detection

const unsupported = (reason, script) => ({ unsupported: true, reason, script });

/**
 * detectRunner(pkgJson) ->
 *   { runner: string[], from: string }                  // usable
 * | { unsupported: true, reason: string, script: string }
 * | null                                                // no test script at all
 */
function detectRunner(pkgJson) {
  const scripts = (pkgJson && pkgJson.scripts) || {};
  if (!scripts.test || !String(scripts.test).trim()) return null;

  const r = resolveScript(scripts);
  if (r.bail) return unsupported(r.bail, r.from);

  let tokens = r.tokens;
  // An env-dependent command is refused, not stripped: verify.config.json has no place to put the
  // variable, so stripping `NODE_OPTIONS=--experimental-vm-modules` would produce a runner that
  // looks right and fails on every ESM repo. A loud refusal is safe; a silent mis-run is not.
  const env = tokens.filter(isEnvAssignment);
  while (tokens.length && (isEnvAssignment(tokens[0]) || PASSTHROUGH.has(binName(tokens[0])))) tokens = tokens.slice(1);
  if (env.length) {
    return unsupported(
      `the test script needs the environment variable ${env[0].split("=")[0]}, which verify.config.json cannot express`,
      r.from
    );
  }
  if (!tokens.length) return unsupported("the test script runs no command", r.from);

  const bin = binName(tokens[0]);
  if (bin !== "jest" && bin !== "vitest") {
    const why = KNOWN_OTHER[bin];
    return unsupported(why || `\`${bin}\` is not a supported test runner (jest and vitest are)`, r.from);
  }

  let rest = tokens.slice(1);
  // vitest takes a subcommand. `run` is the only one that means "execute the suite once and exit";
  // bare `vitest` is watch mode, which would hang the agent forever. Normalize by dropping whatever
  // subcommand is there and always re-adding `run` — a positional would otherwise be filtered out
  // with the rest of the path filters.
  if (bin === "vitest") {
    const sub = rest[0] && !rest[0].startsWith("-") ? rest[0] : null;
    if (sub && !["run", "watch", "dev"].includes(sub)) {
      return unsupported(`\`vitest ${sub}\` is not a plain test run`, r.from);
    }
    if (sub) rest = rest.slice(1);
  }

  const args = filterFlags(rest, bin);
  if (bin === "vitest") args.unshift("run");

  return { runner: [bin, ...args], from: r.from };
}

// ---------------------------------------------------------------- the probe

// Detection is a parser, and parsers are wrong sometimes. So before we call the config good, run it
// once, for real, against a single test file and insist on a report we can actually read. This is
// what catches a wrong --config at install time instead of six weeks later inside a demo.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".codegraph", "dist", "build", "out", "coverage", ".next", ".nuxt", "vendor",
]);
const IS_TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Breadth-first, directory entries sorted, so the same repo always probes the same file.
function findOneTestFile(root) {
  const queue = [root];
  for (let visited = 0; queue.length && visited < 4000; visited++) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const e of entries) if (e.isFile() && IS_TEST_FILE.test(e.name)) return path.join(dir, e.name);
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) queue.push(path.join(dir, e.name));
    }
  }
  return null;
}

// Is the runner actually installed here? Checked directly, walking up for a hoisted monorepo
// node_modules, because the alternative is `npx` deciding to DOWNLOAD jest mid-install — slow,
// networked, and it would probe a different binary than cg:verify will ever run.
function runnerInstalled(target, bin) {
  for (let dir = path.resolve(target); ; ) {
    if (fs.existsSync(path.join(dir, "node_modules", ".bin", bin))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

// Ask the runner itself which files its config owns. This matters: a filesystem walk finds the
// FIRST test file in the repo, which in a monorepo is routinely one the suite deliberately excludes
// (react-hook-form's jest config has roots: ['<rootDir>/src'], so app/src/App.test.tsx is not its
// business). Probing that file reports zero tests and looks exactly like a wrong --config. Asking
// the runner removes the ambiguity: whatever it lists, it will run.
function listSuiteFiles(target, affected) {
  const runner = affected.runnerConfig();
  const args =
    affected.runnerFamily() === "vitest"
      ? [...runner.map(a => (a === "run" ? "list" : a)), "--filesOnly", "--json"]
      : [...runner, "--listTests", "--json"];
  const res = spawnSync("npx", args, { cwd: target, encoding: "utf8", timeout: 5 * 60 * 1000 });
  const out = String(res.stdout || "");
  const from = out.indexOf("[");
  if (from === -1) return null; // older vitest has no `list`; caller falls back to the walk
  try {
    const files = JSON.parse(out.slice(from, out.lastIndexOf("]") + 1));
    return Array.isArray(files) ? files.map(String).sort() : null;
  } catch {
    return null;
  }
}

/**
 * probeRunner(target) -> { ok, reason?, file?, tests?, verdict? }
 *
 * Uses the TARGET's own copy of affected.cjs, so what we exercise is exactly the argv cg:verify
 * will build — including its reading of the verify.config.json we just wrote.
 */
function probeRunner(target) {
  const affectedPath = path.join(target, "codegraph-ext", "affected.cjs");
  if (!fs.existsSync(affectedPath)) {
    return { ok: false, unavailable: true, reason: "codegraph-ext/affected.cjs is not installed yet" };
  }

  let affected;
  try {
    delete require.cache[require.resolve(affectedPath)];
    affected = require(affectedPath);
  } catch (e) {
    return { ok: false, unavailable: true, reason: `could not load codegraph-ext/affected.cjs (${e.message})` };
  }

  // "we could not run the probe" and "the probe ran and the report was unreadable" are different
  // findings. Only the second one is evidence that the config is wrong, so only the second one is
  // allowed to make `--check` say NOT READY; whether the user has installed their own deps is not
  // this kit's business.
  const bin = path.basename(String(affected.runnerConfig()[0] || "")).replace(/\.(?:[cm]?js)$/, "");
  if (!runnerInstalled(target, bin)) {
    return { ok: false, unavailable: true, reason: `\`${bin}\` is not installed in this repo (run its install first)` };
  }

  const listed = listSuiteFiles(target, affected);
  if (listed && !listed.length) {
    return { ok: false, reason: "this runner's config matches no test files at all" };
  }
  const file = listed ? listed[0] : findOneTestFile(target);
  if (!file) return { ok: false, unavailable: true, reason: "no *.test.* / *.spec.* file found to probe with" };
  const authoritative = !!listed;

  const rel = path.relative(target, file).split(path.sep).join("/");
  const tmp = path.join(os.tmpdir(), `cg-probe-${process.pid}-${Date.now()}.json`);
  try {
    const { args } = affected.runnerArgs([...affected.jsonReportArgs(tmp), "--", rel]);
    const res = spawnSync("npx", args, { cwd: target, stdio: "ignore", timeout: 10 * 60 * 1000 });
    let report;
    try {
      report = JSON.parse(fs.readFileSync(tmp, "utf8"));
    } catch {
      const how = res.error ? res.error.message : `exit ${res.status}`;
      return { ok: false, file: rel, reason: `the runner produced no parseable JSON report (${how})` };
    }
    const total = report.numTotalTests || 0;
    if (!total) {
      const v = affected.testReportVerdict(report);
      if (v.crashed.length) {
        return { ok: false, file: rel, reason: "the suite failed to LOAD under this runner — the derived config is probably wrong" };
      }
      return {
        ok: false,
        file: rel,
        reason: authoritative
          ? "the runner listed this file and then reported zero tests in it"
          : `zero tests reported for ${rel} — it may not be part of this repo's suite`,
      };
    }
    // A red suite is fine here: we are proving the report is readable, not that the repo is green.
    return { ok: true, file: rel, tests: total, verdict: affected.testReportVerdict(report).ok };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------- file I/O

const configPath = target => path.join(target, "codegraph-ext", "verify.config.json");

function readPkg(target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeConfig(target, runner) {
  const file = configPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ runner }, null, 2) + "\n");
  return file;
}

// The hand-written escape hatch, printed whenever we refuse.
function snippet(target) {
  return [
    `    Write it by hand if you know the right command:`,
    `      ${path.join(target, "codegraph-ext", "verify.config.json")}`,
    `      { "runner": ["jest", "--config", "path/to/jest.config.js"] }`,
    `    Until then cg:verify runs a bare \`npx jest\`, which may not be your suite.`,
  ];
}

// ---------------------------------------------------------------- CLI

function parseOpts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") o.target = argv[++i];
    else if (argv[i].startsWith("--target=")) o.target = argv[i].slice(9);
  }
  return o;
}

function main(argv) {
  const cmd = argv[0];
  const { target } = parseOpts(argv.slice(1));
  if (!target) throw new Error(`${cmd || "detect-runner"} needs --target <abs path>`);
  const abs = path.resolve(target);
  const log = m => console.log(m);

  if (cmd === "detect") {
    console.log(JSON.stringify(detectRunner(readPkg(abs)), null, 2));
    return 0;
  }

  if (cmd === "emit") {
    // An existing config is the user's override and always wins — same rule as annotations.json.
    // (install.sh's copy loop globs *.cjs, so it cannot clobber this file; this is the only writer.)
    if (fs.existsSync(configPath(abs))) {
      log("    verify.config.json already present — keeping it");
      return 0;
    }
    const r = detectRunner(readPkg(abs));
    if (!r) {
      log("    no `scripts.test` in package.json — cannot derive the test runner");
      snippet(abs).forEach(log);
      return 0;
    }
    if (r.unsupported) {
      log(`    cannot derive the test runner: ${r.reason}`);
      log(`      scripts.test = ${r.script}`);
      snippet(abs).forEach(log);
      return 0;
    }
    writeConfig(abs, r.runner);
    log(`    derived from \`${r.from}\`  ->  npx ${r.runner.join(" ")}`);
    const p = probeRunner(abs);
    if (p.ok) log(`    probe: ${p.file} -> ${p.tests} test(s) reported${p.verdict ? "" : " (red, but readable)"}`);
    else if (p.unavailable) log(`    probe skipped: ${p.reason}`);
    else {
      log(`    WARNING: probe failed — ${p.reason}`);
      log(`      the derived runner may be wrong; edit ${path.join("codegraph-ext", "verify.config.json")}`);
    }
    return 0;
  }

  if (cmd === "check") {
    const p = probeRunner(abs);
    if (p.ok) {
      const cfg = fs.existsSync(configPath(abs)) ? JSON.parse(fs.readFileSync(configPath(abs), "utf8")).runner : ["jest"];
      log(`    [ok]      test runner verified (${cfg.join(" ")} -> ${p.tests} tests)`);
      return 0;
    }
    if (p.unavailable) {
      log(`    [warn]    test runner not verified — ${p.reason}`);
      return 0;
    }
    log(`    [MISSING] test runner produces no parseable report — verify will always fail`);
    log(`              ${p.reason}`);
    return 1;
  }

  throw new Error(`unknown command '${cmd}' (detect|emit|check)`);
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }
}

module.exports = { detectRunner, probeRunner, writeConfig, configPath, tokenize, filterFlags };
