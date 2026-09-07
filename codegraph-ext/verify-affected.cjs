#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/verify-affected.cjs  (npm run cg:verify)
 *
 * Runs the affected tests and returns ONE compact verdict - PASS/FAIL, counts, and a deduped list
 * of failures - instead of a wall of jest output. MEMOIZED: re-running without changing any input
 * file returns the cached verdict with NO jest run (kills the "verify after every micro-edit" waste).
 *
 * Usage:
 *   npm run cg:verify                 # infer changed files from `git diff`
 *   npm run cg:verify -- src/a.ts     # explicit changed file(s)
 *   npm run cg:verify -- --types      # also run tsc --noEmit, report errors in changed files
 *   npm run cg:verify -- --no-cache   # force a fresh jest run
 *
 * Exit code: 0 only if every affected test passes (and, with --types, no type errors in changed files).
 */
const {
  inferChangedFromGit,
  resolveAffectedTests,
  jestArgs,
  fingerprint,
  suiteFingerprint,
  readVerifyCache,
  writeVerifyCache,
  spawnSync,
  fs,
  path,
  APP_ROOT,
} = require("./affected.cjs");

const argv = process.argv.slice(2);
const withTypes = argv.includes("--types");
const noCache = argv.includes("--no-cache");
let changed = argv.filter(a => !a.startsWith("--"));
if (!changed.length) changed = inferChangedFromGit();

if (!changed.length) {
  console.log("[cg:verify] no changed .ts/.tsx files detected (pass files explicitly, or make an edit).");
  process.exit(0);
}

let mapping, testList;
try {
  ({ mapping, testList } = resolveAffectedTests(changed));
} catch (e) {
  console.error(`[cg:verify] ${e.message}`);
  process.exit(1);
}

// ---------- memoization: fingerprint the exact inputs (changed files + covering tests) ----------
const fp = fingerprint([...changed, ...testList]) + (withTypes ? "+types" : "");
const cache = readVerifyCache();
if (!noCache && cache[fp]) {
  console.log(cache[fp].block);
  console.log("[cg:verify] (cached - inputs unchanged since last run, no jest executed)\n");
  process.exit(cache[fp].ok ? 0 : 1);
}

const lines = [];
lines.push("=== cg:verify ===");
lines.push(`changed: ${changed.length} file(s) -> ${testList.length} covering test file(s)`);

let ok = true;

// ---------- gate 2: sticky-PASS — skip suites whose coverage set is unchanged AND already green ----------
// SAFETY: this trusts the graph's DIRECT 'covers' edges. A suite can be broken by a TRANSITIVELY
// imported source that isn't in its recorded coverage set — editing that source won't change the
// suite's fingerprint, so it would be wrongly skipped and reported green (a false PASS that trips the
// PASS-latch). The whole-input memo above (gate 1) is safe because it hashes the cumulative git diff.
// So sticky-PASS is OFF by default; opt in with CG_STICKY_PASS=1 only if you trust the coverage graph.
const STICKY = process.env.CG_STICKY_PASS === "1";
const suiteKey = t => `suite:${t}`;
const suiteFp = {};
const stickyPass = [];
let toRun = [];
for (const t of testList) {
  const fpS = suiteFingerprint(t);
  suiteFp[t] = fpS;
  const entry = cache[suiteKey(t)];
  if (STICKY && !noCache && entry && entry.ok && entry.fp === fpS) stickyPass.push(t);
  else toRun.push(t);
}
if (stickyPass.length) {
  lines.push(
    `sticky-PASS: ${stickyPass.length} suite(s) skipped (coverage set unchanged since last green run)`
  );
}

// ---------- jest (only the suites that actually need re-running) ----------
if (!testList.length) {
  lines.push("tests: (no covering test found - nothing to run)");
} else if (!toRun.length) {
  lines.push(`tests: PASS  (all ${stickyPass.length} affected suite(s) already green, coverage unchanged)`);
} else {
  const tmp = path.join(APP_ROOT, ".codegraph", `jest-${Date.now()}.json`);
  const { args } = jestArgs(["--json", `--outputFile=${tmp}`, "--", ...toRun]);
  spawnSync("npx", args, { cwd: APP_ROOT, stdio: "ignore" });
  try {
    const r = JSON.parse(fs.readFileSync(tmp, "utf8"));
    const pass = r.numPassedTests || 0;
    const total = r.numTotalTests || 0;
    const failed = r.numFailedTests || 0;
    lines.push(
      `tests: ${r.success && failed === 0 ? "PASS" : "FAIL"}  (${pass}/${total} passed, ${failed} failed` +
        `${stickyPass.length ? `, +${stickyPass.length} sticky-PASS suite(s)` : ""})`
    );
    // per-suite result -> update sticky cache: PASS sticks, FAIL always re-runs until fixed
    const failedSuites = new Set();
    for (const suite of r.testResults || []) {
      const rel = path.relative(APP_ROOT, suite.name).split(path.sep).join("/");
      const suitePassed = (suite.assertionResults || []).every(t => t.status !== "failed");
      if (suiteFp[rel] != null) cache[suiteKey(rel)] = { ok: suitePassed, fp: suiteFp[rel] };
      if (!suitePassed) failedSuites.add(rel);
    }
    if (failed) {
      ok = false;
      const seen = new Set();
      const srcCache = new Map();
      const srcLine = (abs, n) => {
        if (!srcCache.has(abs)) {
          try {
            srcCache.set(abs, fs.readFileSync(abs, "utf8").split("\n"));
          } catch (_) {
            srcCache.set(abs, null);
          }
        }
        const arr = srcCache.get(abs);
        return arr && arr[n - 1] != null ? arr[n - 1] : null;
      };
      // Pull the FIRST stack frame that points into THIS test file -> the assertion's line number.
      const assertLine = (msg, testAbs) => {
        const base = path.basename(testAbs).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(base + ":(\\d+):\\d+");
        for (const l of String(msg).split("\n")) {
          const m = l.match(re);
          if (m) return parseInt(m[1], 10);
        }
        return null;
      };
      for (const suite of r.testResults || []) {
        const relTest = path.relative(APP_ROOT, suite.name).split(path.sep).join("/");
        for (const t of suite.assertionResults || []) {
          if (t.status !== "failed") continue;
          const name = [...(t.ancestorTitles || []), t.title].join(" > ");
          const fm = t.failureMessages && t.failureMessages[0] ? t.failureMessages[0] : "";
          const msgLines = fm.split("\n").map(s => s.trim());
          const firstMsg =
            msgLines.find(s => /^(expect|Error|Received|Expected)/.test(s)) || "(see full jest output)";
          const exp = msgLines.find(s => /^Expected/.test(s));
          const rec = msgLines.find(s => /^Received/.test(s));
          const ln = assertLine(fm, suite.name);
          const key = name + firstMsg + ln;
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(`    ${name}`);
          lines.push(`       ${firstMsg}`);
          if (exp && rec && !/^(expect|Expected)/.test(firstMsg)) lines.push(`       ${exp}   ${rec}`);
          // HYDRATE: the exact edit site -> file:line + the current source line, so the model can go
          // straight to codegraph_apply_edit_at_site instead of hunting with locate (which can't find
          // literal asserts — it indexes symbols, not code lines).
if (ln != null) {
            const cur = srcLine(suite.name, ln);
            lines.push(`       @ ${relTest}:${ln}${cur != null ? `   ${cur.trim()}` : ""}`);
            // HYDRATE the ENCLOSING test block so parameterized structure (test.each over N cases) is
            // visible IN the verdict — otherwise the model can't tell a 1-line swap from a change that
            // would break sibling cases, and it burns calls reading/locating to discover the shape.
            const arr = srcCache.get(suite.name);
            if (arr) {
              let start = ln;
              for (let L = ln; L >= 1 && L > ln - 60; L--) {
                const line = arr[L - 1] || "";
                if (/\b(it|test)(\.each)?\s*\(/.test(line) || /\.each\s*\(\s*\[/.test(line)) {
                  start = L;
                  break;
                }
              }
              const end = Math.min(arr.length, ln + 2);
              const emit = (a, b) => {
                for (let L = a; L <= b; L++) lines.push(`          ${String(L).padStart(4)}  ${arr[L - 1]}`);
              };
              if (start < ln) {
                lines.push(`       └ enclosing test block:`);
                if (end - start <= 30) emit(start, end);
                else {
                  emit(start, start + 8);
                  lines.push(`           …`);
                  emit(ln - 3, end);
                }
              }
            }
          }
        }
      }
      lines.push(
        `    -> fix each at the '@ file:line' shown above via codegraph_apply_edit_at_site (batch them in ONE call), then it re-verifies.`
      );
    }
  } catch (_) {
    ok = false;
    lines.push("tests: ERROR - jest produced no parseable result (run `npm run cg:test` for raw output).");
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
  }
}

// ---------- optional tsc (scoped to changed files) ----------
if (withTypes) {
  const tsconfig = ["tsconfig.json", "tsconfig.app.json"].find(f => fs.existsSync(path.join(APP_ROOT, f)));
  if (!tsconfig) {
    lines.push("types: (no tsconfig found - skipped)");
  } else {
    const r = spawnSync("npx", ["tsc", "--noEmit", "--skipLibCheck", "-p", tsconfig], {
      cwd: APP_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const changedSet = new Set(changed.map(c => c.replace(/^\.\//, "")));
    const errs = out
      .split("\n")
      .filter(l => /error TS\d+/.test(l))
      .filter(l => [...changedSet].some(c => l.includes(c)));
    if (errs.length) {
      ok = false;
      lines.push(`types: FAIL  (${errs.length} error(s) in changed files)`);
      [...new Set(errs)].slice(0, 20).forEach(e => lines.push(`    ${e.trim()}`));
    } else {
      lines.push("types: PASS  (no type errors in changed files)");
    }
  }
}

lines.push(`\nverdict: ${ok ? "PASS" : "FAIL"}`);
const block = "\n" + lines.join("\n") + "\n";
console.log(block);

// store verdict under this input fingerprint so identical re-runs are free
cache[fp] = { ok, block };
writeVerifyCache(cache);

process.exit(ok ? 0 : 1);
