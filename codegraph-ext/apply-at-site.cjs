#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/apply-at-site.cjs  (codegraph_apply_edit_at_site)
 *
 * Collapses the read -> anchor -> edit dance into ONE call. The model already saw the exact,
 * line-NUMBERED code in plan/locate/impact output, so it can point at a site by (file, line) and a
 * tiny find/replace — and the SERVER fetches that line's context itself. No whole-file read to build
 * an anchor, no anchor ambiguity (scoped to one line). Batched + atomic + optional single verify.
 *
 * Spec (JSON, file arg or stdin) — array of site edits:
 *   [ { "file":"src/a.ts", "line":278, "find":"strokeWidth: 1", "replace":"strokeWidth: 3" }, ... ]
 *   - find     : substring on THAT line to swap (rest of the line preserved). Omit to replace the
 *                whole line — then `replace` is the new full line content (include indentation).
 *   - expect   : optional guard — the current line must contain this, else the whole batch aborts.
 * All-or-nothing: any bad site writes nothing.
 *
 * Usage:  node apply-at-site.cjs edits.json [--verify] [--dry]
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const APP_ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const verify = argv.includes("--verify");
const specArg = argv.find(a => !a.startsWith("--"));

let edits;
try {
  const raw = specArg ? fs.readFileSync(path.resolve(APP_ROOT, specArg), "utf8") : fs.readFileSync(0, "utf8");
  const parsed = JSON.parse(raw);
  edits = Array.isArray(parsed) ? parsed : parsed.edits;
  if (!Array.isArray(edits)) throw new Error("spec must be an array of site edits, or { edits: [...] }");
} catch (e) {
  console.error(`[cg:site] cannot read spec: ${e.message}`);
  process.exit(1);
}

// stage into an in-memory { rel -> lines[] } so multiple edits to a file see prior changes
const fileCache = new Map();
const load = rel => {
  if (!fileCache.has(rel)) fileCache.set(rel, fs.readFileSync(path.resolve(APP_ROOT, rel), "utf8").split("\n"));
  return fileCache.get(rel);
};
const results = [];
let hardFail = false;

edits.forEach((e, i) => {
  const tag = `#${i + 1} ${e.file}:${e.line}`;
  if (!e.file || !Number.isInteger(e.line) || typeof e.replace !== "string") {
    results.push({ tag, ok: false, msg: "missing file/line(int)/replace" });
    hardFail = true;
    return;
  }
  let lines;
  try {
    lines = load(e.file);
  } catch (_) {
    results.push({ tag, ok: false, msg: "file not found" });
    hardFail = true;
    return;
  }
  const cur = lines[e.line - 1];
  if (cur == null) {
    results.push({ tag, ok: false, msg: `line ${e.line} out of range (file has ${lines.length} lines)` });
    hardFail = true;
    return;
  }
  if (e.expect != null && !cur.includes(e.expect)) {
    results.push({ tag, ok: false, msg: `guard failed — line does not contain «${e.expect}» (actual: ${cur.trim()})` });
    hardFail = true;
    return;
  }
  let next;
  if (typeof e.find === "string") {
    if (!cur.includes(e.find)) {
      results.push({ tag, ok: false, msg: `«${e.find}» not on line ${e.line} (actual: ${cur.trim()})` });
      hardFail = true;
      return;
    }
    next = cur.split(e.find).join(e.replace);
  } else {
    next = e.replace; // whole-line replace
  }
  lines[e.line - 1] = next;
  results.push({ tag, ok: true, before: cur.trim(), after: next.trim() });
});

console.log("\n[cg:site] edit plan:");
results.forEach(r =>
  r.ok
    ? console.log(`  OK   ${r.tag}\n         - ${r.before}\n         + ${r.after}`)
    : console.log(`  FAIL ${r.tag} — ${r.msg}`)
);

if (hardFail) {
  console.error("\n[cg:site] ABORTED — a site failed; NOTHING was written. Fix the spec and retry.");
  process.exit(1);
}
if (dry) {
  console.log(`\n[cg:site] --dry: ${fileCache.size} file(s) would change; nothing written.`);
  process.exit(0);
}
for (const [rel, lines] of fileCache) fs.writeFileSync(path.resolve(APP_ROOT, rel), lines.join("\n"));
console.log(`\n[cg:site] applied ${results.length} edit(s) across ${fileCache.size} file(s).`);

if (verify) {
  // IMPORTANT: verify the FULL working-tree diff (no file args -> verify-affected infers from git),
  // NOT just this batch's files. A batch-scoped verify would report a local PASS while suites touched
  // by EARLIER apply calls are still red -> a false global PASS that trips the PASS-latch. Always global.
  console.log(`\n[cg:site] verifying once (cg:verify) over the FULL working-tree diff…`);
  const r = spawnSync("node", [path.join(__dirname, "verify-affected.cjs")], {
    cwd: APP_ROOT,
    stdio: "inherit",
  });
  process.exit(r.status == null ? 1 : r.status);
}
process.exit(0);
