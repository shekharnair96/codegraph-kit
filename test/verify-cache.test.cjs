/* Regression tests for the verify-cache schema stamp (codegraph-ext/affected.cjs).
 *
 * Commit 6a01248 fixed HOW a verdict is computed (testReportVerdict()/suiteRanOk(): a suite that
 * fails to LOAD reports numTotalTests: 0 AND numFailedTests: 0, so counting failed assertions alone
 * scored it green). It never invalidated verdicts a PRE-fix run had already written to
 * .codegraph/verify-cache.json — so every existing cache entry kept serving its old, wrong PASS.
 *
 * Two on-disk layers share that one file: the whole-run cache (keyed by an md5 input fingerprint,
 * `{ ok, block }`) and the sticky per-suite cache (keyed by `suite:<path>`, `{ ok, fp }`,
 * CG_STICKY_PASS=1 only). readVerifyCache() now discards the WHOLE file when its `__schema__` stamp
 * doesn't match CACHE_SCHEMA, which invalidates both entry kinds at once with no user action, plus
 * drops any individually self-inconsistent entry (ok:true whose own block reports a FAIL) as a
 * second line of defense.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KIT = path.join(__dirname, "..");

// Fresh copy of affected.cjs (+ its one local dependency) into a scratch dir per test, so
// APP_ROOT (== path.join(__dirname, "..") inside affected.cjs) — and therefore VERIFY_CACHE —
// points at throwaway scratch space instead of the kit's own .codegraph/.
function freshAffected(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-kit-cache-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ext = path.join(tmp, "codegraph-ext");
  fs.mkdirSync(ext, { recursive: true });
  for (const f of ["affected.cjs", "sqlite-bin.cjs"]) {
    fs.copyFileSync(path.join(KIT, "codegraph-ext", f), path.join(ext, f));
  }
  const modPath = path.join(ext, "affected.cjs");
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

test("a cache file written by the pre-fix code (no schema stamp) is discarded wholesale, not served", () => {
  const a = freshAffected(test);
  const legacy = {
    // whole-run entry, exactly the shape 6a01248's own PR description reproduced: a suite that
    // failed to load, scored PASS.
    fp1234567890abcdef1234567890abcd: {
      ok: true,
      block: "\n=== cg:verify ===\ntests: FAIL  (0/0 passed, 0 failed)\n\nverdict: PASS\n",
    },
    // sticky per-suite entry from the same pre-fix run.
    "suite:src/a.test.ts": { ok: true, fp: "deadbeefdeadbeefdeadbeefdeadbeef" },
  };
  fs.mkdirSync(path.dirname(a.VERIFY_CACHE), { recursive: true });
  fs.writeFileSync(a.VERIFY_CACHE, JSON.stringify(legacy));

  const cache = a.readVerifyCache();
  assert.deepStrictEqual(cache, {}, "an unstamped (pre-fix) cache must be discarded in full");
});

test("a self-inconsistent entry (ok:true, block reports FAIL) is dropped even under the current schema", () => {
  const a = freshAffected(test);
  const poisoned = {
    [a.SCHEMA_KEY]: a.CACHE_SCHEMA,
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
      ok: true,
      block: "\n=== cg:verify ===\ntests: FAIL  (0/0 passed, 0 failed)\n\nverdict: FAIL\n",
    },
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { ok: true, block: "\n=== cg:verify ===\ntests: PASS\n\nverdict: PASS\n" },
  };
  fs.mkdirSync(path.dirname(a.VERIFY_CACHE), { recursive: true });
  fs.writeFileSync(a.VERIFY_CACHE, JSON.stringify(poisoned));

  const cache = a.readVerifyCache();
  assert.strictEqual(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" in cache,
    false,
    "an ok:true entry whose own block reports FAIL must never be served"
  );
  assert.strictEqual(
    cache.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.ok,
    true,
    "a genuinely consistent entry must survive alongside a dropped poisoned one"
  );
});

test("a poisoned sticky suite: entry from a pre-fix cache cannot cause the suite to be skipped", () => {
  const a = freshAffected(test);
  const suiteKey = t => `suite:${t}`;
  const testRel = "src/a.test.ts";
  const legacy = { [suiteKey(testRel)]: { ok: true, fp: "poisoned-fingerprint" } }; // no schema stamp
  fs.mkdirSync(path.dirname(a.VERIFY_CACHE), { recursive: true });
  fs.writeFileSync(a.VERIFY_CACHE, JSON.stringify(legacy));

  const cache = a.readVerifyCache();
  // This is verify-affected.cjs's own sticky-PASS decision (CG_STICKY_PASS=1):
  //   const entry = cache[suiteKey(t)];
  //   if (STICKY && !noCache && entry && entry.ok && entry.fp === fpS) stickyPass.push(t);
  // Reproduced here against whatever fingerprint the suite actually has now — a poisoned entry
  // must not satisfy it, regardless of what `fp` it claims.
  const entry = cache[suiteKey(testRel)];
  assert.strictEqual(entry, undefined, "the poisoned suite: entry must not survive the read");
  const wouldSkip = Boolean(entry && entry.ok && entry.fp === "poisoned-fingerprint");
  assert.strictEqual(wouldSkip, false, "a poisoned sticky entry must not cause the suite to be skipped");
});

test("a current-schema, self-consistent entry IS still served from cache (memoization keeps working)", () => {
  const a = freshAffected(test);
  const good = {
    [a.SCHEMA_KEY]: a.CACHE_SCHEMA,
    cccccccccccccccccccccccccccccc1: { ok: true, block: "\n=== cg:verify ===\ntests: PASS\n\nverdict: PASS\n" },
    "suite:src/b.test.ts": { ok: true, fp: "goodfingerprint" },
  };
  fs.mkdirSync(path.dirname(a.VERIFY_CACHE), { recursive: true });
  fs.writeFileSync(a.VERIFY_CACHE, JSON.stringify(good));

  const cache = a.readVerifyCache();
  assert.strictEqual(cache.cccccccccccccccccccccccccccccc1.ok, true);
  assert.strictEqual(cache.cccccccccccccccccccccccccccccc1.block, good.cccccccccccccccccccccccccccccc1.block);
  assert.strictEqual(cache["suite:src/b.test.ts"].ok, true);
  assert.strictEqual(cache["suite:src/b.test.ts"].fp, "goodfingerprint");

  // writeVerifyCache() must round-trip through readVerifyCache() with the stamp applied automatically.
  a.writeVerifyCache(cache);
  const reread = a.readVerifyCache();
  assert.strictEqual(reread.cccccccccccccccccccccccccccccc1.ok, true);
});

test("a malformed/empty/absent cache file degrades to {} without throwing", () => {
  const a = freshAffected(test);

  // absent
  assert.deepStrictEqual(a.readVerifyCache(), {});

  // empty file
  fs.mkdirSync(path.dirname(a.VERIFY_CACHE), { recursive: true });
  fs.writeFileSync(a.VERIFY_CACHE, "");
  assert.deepStrictEqual(a.readVerifyCache(), {});

  // malformed JSON
  fs.writeFileSync(a.VERIFY_CACHE, "{not json");
  assert.deepStrictEqual(a.readVerifyCache(), {});

  // valid JSON but not an object (e.g. an array)
  fs.writeFileSync(a.VERIFY_CACHE, "[]");
  assert.deepStrictEqual(a.readVerifyCache(), {});
});
