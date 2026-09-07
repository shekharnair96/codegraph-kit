#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/build-body-index.cjs
 *
 * Builds `node_body_fts` — a full-text index over each symbol's BODY (identifiers + literals),
 * NOT just its name/signature/docstring (which is all `nodes_fts` covers). This is what lets
 * `locate` answer concept-in-body queries like "line width / stroke" → createSingleSeries,
 * whose body contains `strokeWidth: 1` even though the name/sig never say "stroke" or "width".
 *
 * Dependency-free ON PURPOSE (no ts-morph): it reads each node's [start_line,end_line] span
 * straight from the source file and tokenizes with regex. That means it runs anywhere sqlite3 +
 * node + the source tree exist — including the sparse A/B clones that have no node_modules.
 *
 * Tokenization splits camelCase + snake_case so `strokeWidth` → {strokewidth, stroke, width} and
 * `METRIC_SERIES_COLORS` → {metric, series, colors}. Hex colors and quoted-string words are kept.
 * Idempotent: drops + rebuilds the table every run. Records a fingerprint in project_metadata so
 * callers can detect staleness (node count changed).
 */
const { execFileSync } = require("child_process");
const { sqliteBin } = require("./sqlite-bin.cjs");
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const DB = path.join(APP_ROOT, ".codegraph", "codegraph.db");

if (!fs.existsSync(DB)) {
  console.error(`[body-index] no codegraph DB at ${DB} — run \`codegraph index\` first.`);
  process.exit(1);
}

function query(sql) {
  const out = execFileSync(sqliteBin(), ["-json", DB, sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}
function runScript(statements) {
  const script = "PRAGMA foreign_keys=OFF;\nBEGIN;\n" + statements.join("\n") + "\nCOMMIT;\n";
  execFileSync(sqliteBin(), [DB], { input: script, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}
const esc = s => String(s == null ? "" : s).replace(/'/g, "''");

// JS/TS keywords + ultra-common words that carry no discovery signal (BM25 downweights them
// anyway, but dropping keeps the index tight and the ranking sharp).
const STOP = new Set(
  ("const let var function return import export from default true false null undefined this new typeof " +
    "await async void extends implements interface type enum class public private protected readonly static " +
    "string number boolean object array record partial the and for with not into out via see " +
    "if else switch case break continue while do try catch finally throw yield of in as is")
    .split(/\s+/)
);

function splitIdent(id) {
  const parts = new Set();
  const lower = id.toLowerCase();
  if (lower.length >= 3) parts.add(lower); // keep whole identifier (>=3 to skip i/j/x noise)
  id.split(/[_$]+/).forEach(p => {
    if (p) parts.add(p.toLowerCase());
  });
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .forEach(p => {
      if (p) parts.add(p.toLowerCase());
    });
  return [...parts].filter(p => p.length >= 2 && !STOP.has(p) && !/^\d+$/.test(p));
}

function tokensForSpan(fileRel, startLine, endLine) {
  const abs = path.join(APP_ROOT, fileRel);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch (_) {
    return "";
  }
  const lines = src.split("\n");
  const end = Math.min(endLine || startLine, startLine + 400); // cap huge spans
  const body = lines.slice(Math.max(0, startLine - 1), end).join("\n");
  const toks = new Set();
  (body.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).forEach(w => splitIdent(w).forEach(t => toks.add(t)));
  (body.match(/#[0-9a-fA-F]{3,8}\b/g) || []).forEach(h => toks.add(h.toLowerCase()));
  (body.match(/(["'`])((?:\\.|(?!\1).){2,}?)\1/g) || []).forEach(s => {
    s.slice(1, -1)
      .split(/[^A-Za-z0-9#]+/)
      .forEach(w => {
        if (w.length >= 2 && !STOP.has(w.toLowerCase())) toks.add(w.toLowerCase());
      });
  });
  return [...toks].join(" ");
}

const KINDS = ["function", "method", "class", "variable", "constant", "interface", "type_alias", "enum"];
const rows = query(
  `SELECT rowid, id, file_path, start_line, end_line FROM nodes ` +
    `WHERE kind IN (${KINDS.map(k => `'${k}'`).join(",")}) ` +
    `AND language != 'ext' AND start_line > 0 AND file_path NOT LIKE 'file:%' ` +
    `ORDER BY rowid;`
);

const stmts = [
  "DROP TABLE IF EXISTS node_body_fts;",
  "CREATE VIRTUAL TABLE node_body_fts USING fts5(node_id UNINDEXED, rowid_ref UNINDEXED, tokens);",
];
let indexed = 0;
for (const r of rows) {
  const toks = tokensForSpan(r.file_path, r.start_line, r.end_line);
  if (!toks) continue;
  stmts.push(
    `INSERT INTO node_body_fts (node_id, rowid_ref, tokens) VALUES ('${esc(r.id)}', ${r.rowid}, '${esc(toks)}');`
  );
  indexed++;
}
const NOW = Date.now();
stmts.push(
  `INSERT OR REPLACE INTO project_metadata (key,value,updated_at) VALUES ('ext:body_index_count','${indexed}',${NOW});`,
  `INSERT OR REPLACE INTO project_metadata (key,value,updated_at) VALUES ('ext:body_index_nodes','${rows.length}',${NOW});`
);
runScript(stmts);
console.log(`[body-index] indexed ${indexed} symbol bodies (of ${rows.length} candidate nodes).`);
