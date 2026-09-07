#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/apply-edits.cjs  (npm run cg:apply)
 *
 * Applies many anchored replacements across MULTIPLE files in ONE call, atomically. Collapses N
 * per-file edit turns into a single operation. All-or-nothing: if any anchor is missing or
 * ambiguous, NOTHING is written and the failures are reported, so a bad anchor can never leave a
 * half-applied change.
 *
 * Spec (JSON, from a file arg or stdin):
 *   [ { "file": "src/a.ts", "old": "<exact text>", "new": "<replacement>", "count": 1 }, ... ]
 *   (also accepts { "edits": [ ... ] }.  "count" is optional, defaults to 1 = must match exactly once.)
 *
 * Usage:
 *   npm run cg:apply -- edits.json
 *   cat edits.json | npm run cg:apply
 *   npm run cg:apply -- edits.json --dry     # validate only, write nothing
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const APP_ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const verify = argv.includes("--verify");
const specArg = argv.find(a => !a.startsWith("--"));

function readSpec() {
  let raw;
  if (specArg) raw = fs.readFileSync(path.resolve(APP_ROOT, specArg), "utf8");
  else raw = fs.readFileSync(0, "utf8"); // stdin
  const parsed = JSON.parse(raw);
  const edits = Array.isArray(parsed) ? parsed : parsed.edits;
  if (!Array.isArray(edits)) throw new Error("spec must be an array of edits, or { edits: [...] }");
  return edits;
}

let edits;
try {
  edits = readSpec();
} catch (e) {
  console.error(`[cg:apply] cannot read spec: ${e.message}`);
  process.exit(1);
}

// ---------- validate everything in memory first (atomic) ----------
const fileCache = new Map(); // relPath -> current (working) content as we stage edits
const results = [];
let hardFail = false;

function load(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const abs = path.resolve(APP_ROOT, rel);
  const content = fs.readFileSync(abs, "utf8");
  fileCache.set(rel, content);
  return content;
}

edits.forEach((e, i) => {
  const tag = `#${i + 1} ${e.file}`;
  if (!e.file || typeof e.old !== "string" || typeof e.new !== "string") {
    results.push({ tag, ok: false, msg: "missing file/old/new" });
    hardFail = true;
    return;
  }
  let content;
  try {
    content = load(e.file);
  } catch (_) {
    results.push({ tag, ok: false, msg: "file not found" });
    hardFail = true;
    return;
  }
  const occurrences = content.split(e.old).length - 1;
  const want = e.count == null ? 1 : e.count;
  if (occurrences === 0) {
    results.push({ tag, ok: false, msg: "anchor not found (old text absent)" });
    hardFail = true;
    return;
  }
  if (want === 1 && occurrences > 1) {
    results.push({
      tag,
      ok: false,
      msg: `anchor ambiguous (${occurrences} matches) — add more context or set "count"`,
    });
    hardFail = true;
    return;
  }
  if (want !== "all" && occurrences !== want) {
    results.push({ tag, ok: false, msg: `expected ${want} match(es) but found ${occurrences}` });
    hardFail = true;
    return;
  }
  // stage into the cache so overlapping edits to the same file see prior changes
  const staged = want === "all" ? content.split(e.old).join(e.new) : content.replace(e.old, e.new);
  fileCache.set(e.file, staged);
  results.push({ tag, ok: true, msg: `staged (${occurrences === 1 ? "1 site" : occurrences + " sites"})` });
});

// ---------- report ----------
console.log("\n[cg:apply] edit plan:");
results.forEach(r => console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.tag} — ${r.msg}`));

if (hardFail) {
  console.error(
    "\n[cg:apply] ABORTED — one or more anchors failed; NOTHING was written. Fix the spec and retry."
  );
  process.exit(1);
}
if (dry) {
  console.log(`\n[cg:apply] --dry: ${fileCache.size} file(s) would be written; nothing changed.`);
  process.exit(0);
}

// ---------- commit (all anchors valid) ----------
for (const [rel, content] of fileCache) {
  fs.writeFileSync(path.resolve(APP_ROOT, rel), content);
}
console.log(`\n[cg:apply] applied ${results.length} edit(s) across ${fileCache.size} file(s).`);

// ---------- optional single verify (the ONLY sanctioned verify after an edit) ----------
if (verify) {
  const written = [...fileCache.keys()];
  console.log(`\n[cg:apply] verifying once (cg:verify) on ${written.length} written file(s)…`);
  const r = spawnSync("node", [path.join(__dirname, "verify-affected.cjs"), ...written], {
    cwd: APP_ROOT,
    stdio: "inherit",
  });
  process.exit(r.status == null ? 1 : r.status);
}
process.exit(0);
