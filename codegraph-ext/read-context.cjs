#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/read-context.cjs  (npm run cg:read)
 *
 * Returns the RELEVANT slices of many files in ONE call, instead of N sequential full-file reads.
 * Feed it the file:line list from `cg:plan`, or a symbol to grep. Collapses discovery/edit-prep
 * into a single turn and only carries the lines that matter (not whole files).
 *
 * Usage:
 *   npm run cg:read -- src/a.ts:14 src/b.tsx:27        # slices around those lines
 *   npm run cg:read -- METRIC_SERIES_COLORS            # grep the symbol, show each hit + context
 *   npm run cg:read -- <targets> --ctx 10              # context lines each side (default 6)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.join(__dirname, "..");
const DB = path.join(APP_ROOT, ".codegraph", "codegraph.db");
const esc = s => String(s).replace(/'/g, "''");
// Smallest node whose span ENCLOSES [lo,hi]. Used to widen a stray line/short range to a whole
// semantic unit (function/class) so the model gets a complete block, not 6 arbitrary lines — but
// only when the unit is reasonably sized (else we'd re-introduce whole-file dumps).
const MAX_EXPAND = 80;
function enclosingSpan(rel, lo, hi) {
  try {
    if (!fs.existsSync(DB)) return null;
    const rows = execFileSync(
      "sqlite3",
      [
        "-json",
        DB,
        `SELECT start_line s, end_line e FROM nodes WHERE file_path='${esc(rel)}' ` +
          `AND start_line<=${lo} AND end_line>=${hi} AND start_line>0 AND end_line>start_line ` +
          `AND kind IN ('function','method','class','interface','enum','constant','variable') ` +
          `ORDER BY (end_line-start_line) ASC LIMIT 1;`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    const r = rows.trim() ? JSON.parse(rows)[0] : null;
    if (r && r.e - r.s + 1 <= MAX_EXPAND) return [r.s, r.e];
  } catch (_) {
    /* sqlite missing / DB absent -> fall back to ctx window */
  }
  return null;
}
const argv = process.argv.slice(2);
let ctx = 6;
const ci = argv.indexOf("--ctx");
if (ci !== -1 && argv[ci + 1]) ctx = Math.max(0, parseInt(argv[ci + 1], 10) || 6);
const targets = argv.filter((a, i) => !a.startsWith("--") && !(i === ci + 1 && ci !== -1));

if (!targets.length) {
  console.log("[cg:read] usage: cg:read -- <file:line ...> | <symbol>   [--ctx N]");
  process.exit(0);
}

function printSlice(rel, center, ranges) {
  const abs = path.resolve(APP_ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8").split("\n");
  } catch (_) {
    console.log(`\n# ${rel}\n  (cannot read)`);
    return;
  }
  // merge overlapping ranges
  const merged = [];
  ranges
    .sort((a, b) => a[0] - b[0])
    .forEach(([s, e]) => {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    });
  console.log(`\n# ${rel}`);
  merged.forEach(([s, e]) => {
    for (let ln = Math.max(1, s); ln <= Math.min(src.length, e); ln++) {
      console.log(`  ${String(ln).padStart(4)}  ${src[ln - 1]}`);
    }
    if (e < src.length) console.log("  ----");
  });
}

// group targets by file: {rel -> [[start,end], ...]}
const byFile = new Map();
const add = (rel, line) => {
  // expand a single line to its enclosing function/class when that's a sane size, else line ± ctx
  const span = enclosingSpan(rel, line, line);
  const r = span ? [span[0], span[1]] : [Math.max(1, line - ctx), line + ctx];
  if (!byFile.has(rel)) byFile.set(rel, []);
  byFile.get(rel).push(r);
};
// explicit inclusive range 'file:start-end' (expand to enclosing symbol if small, else ctx-pad)
const addRange = (rel, s, e) => {
  const lo = Math.min(s, e), hi = Math.max(s, e);
  const span = enclosingSpan(rel, lo, hi);
  const r = span ? [span[0], span[1]] : [Math.max(1, lo - ctx), hi + ctx];
  if (!byFile.has(rel)) byFile.set(rel, []);
  byFile.get(rel).push(r);
};

for (const t of targets) {
  // 'path:start-end' — accept a line RANGE, not just a single line (agents reach for this to grab
  // a whole test/def block; failing it silently sends them back to a full-file read_file).
  const mr = t.match(/^(.*):(\d+)-(\d+)$/);
  if (mr && fs.existsSync(path.resolve(APP_ROOT, mr[1]))) {
    addRange(mr[1], parseInt(mr[2], 10), parseInt(mr[3], 10));
    continue;
  }
  const m = t.match(/^(.*):(\d+)$/);
  if (m && fs.existsSync(path.resolve(APP_ROOT, m[1]))) {
    add(m[1], parseInt(m[2], 10));
    continue;
  }
  // treat as symbol/pattern -> grep in src
  let out = "";
  try {
    out = execFileSync("grep", ["-rnwI", "--include=*.ts", "--include=*.tsx", t, "src"], {
      cwd: APP_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (_) {
    out = "";
  }
  const hits = out.trim() ? out.trim().split("\n") : [];
  if (!hits.length) {
    console.log(`\n# (no matches for "${t}")`);
    continue;
  }
  hits.forEach(l => {
    const i = l.indexOf(":");
    const j = l.indexOf(":", i + 1);
    if (i < 0 || j < 0) return;
    add(l.slice(0, i), parseInt(l.slice(i + 1, j), 10));
  });
}

for (const [rel, ranges] of byFile) printSlice(rel, null, ranges);
