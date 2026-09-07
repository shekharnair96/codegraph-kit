"use strict";
/**
 * SQLite writer. Uses the `sqlite3` CLI (already required by every codegraph-ext script) so the
 * engine has no native module to compile. Statements are streamed on stdin inside one transaction.
 */
const { execFileSync, spawnSync } = require("child_process");
const { sqliteBin } = require("./sqlite-bin");
const fs = require("fs");
const path = require("path");

const SCHEMA = path.join(__dirname, "schema.sql");

function hasSqlite() {
  // sqliteBin() throws a descriptive error (missing vs. built-without-FTS5); surface it as-is.
  sqliteBin();
  return true;
}

const esc = s => String(s).replace(/'/g, "''");
const lit = v => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${esc(v)}'`);

function run(dbPath, script) {
  const r = spawnSync(sqliteBin(), ["-bail", dbPath], { input: script, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${(r.stderr || "").trim().slice(0, 500)}`);
  return r.stdout;
}

function query(dbPath, sql) {
  const out = execFileSync(sqliteBin(), ["-json", dbPath, sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

function createFresh(dbPath) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (_) {
      /* absent */
    }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  run(dbPath, fs.readFileSync(SCHEMA, "utf8"));
}

function insertNode(n) {
  return (
    `INSERT OR IGNORE INTO nodes (id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,` +
    `docstring,signature,visibility,is_exported,is_async,is_static,is_abstract,decorators,type_parameters,updated_at) VALUES (` +
    [
      lit(n.id), lit(n.kind), lit(n.name), lit(n.qualifiedName), lit(n.filePath), lit(n.language),
      n.startLine, n.endLine, n.startColumn, n.endColumn,
      lit(n.docstring || null), lit(n.signature || null), lit(n.visibility || null),
      n.isExported ? 1 : 0, n.isAsync ? 1 : 0, n.isStatic ? 1 : 0, n.isAbstract ? 1 : 0,
      lit(n.decorators && n.decorators.length ? JSON.stringify(n.decorators) : null),
      lit(n.typeParameters && n.typeParameters.length ? JSON.stringify(n.typeParameters) : null),
      n.updatedAt,
    ].join(",") +
    ");"
  );
}

function insertEdge(e) {
  return (
    `INSERT INTO edges (source,target,kind,metadata,line,col,provenance) VALUES (` +
    [lit(e.source), lit(e.target), lit(e.kind), lit(e.metadata ? JSON.stringify(e.metadata) : null), e.line ?? "NULL", e.col ?? "NULL", "NULL"].join(",") +
    ");"
  );
}

function insertFile(f) {
  return (
    `INSERT OR REPLACE INTO files (path,content_hash,language,size,modified_at,indexed_at,node_count,errors) VALUES (` +
    [lit(f.path), lit(f.contentHash), lit(f.language), f.size, Math.round(f.modifiedAt), f.indexedAt, f.nodeCount, lit(f.errors ? JSON.stringify(f.errors) : null)].join(",") +
    ");"
  );
}

function insertUnresolved(u) {
  return (
    `INSERT INTO unresolved_refs (from_node_id,reference_name,reference_kind,line,col,candidates,file_path,language) VALUES (` +
    [lit(u.fromNodeId), lit(u.name), lit(u.kind), u.line, u.col, lit(u.candidates ? JSON.stringify(u.candidates) : null), lit(u.filePath), lit(u.language)].join(",") +
    ");"
  );
}

function setMeta(key, value, now) {
  return `INSERT OR REPLACE INTO project_metadata (key,value,updated_at) VALUES (${lit(key)},${lit(String(value))},${now});`;
}

function writeGraph(dbPath, graph, meta) {
  const now = Date.now();
  const parts = ["PRAGMA journal_mode=OFF;", "PRAGMA synchronous=OFF;", "BEGIN;"];
  for (const n of graph.nodes) parts.push(insertNode(n));
  for (const e of graph.edges) parts.push(insertEdge(e));
  for (const f of graph.files) parts.push(insertFile(f));
  for (const u of graph.unresolved) parts.push(insertUnresolved(u));
  for (const [k, v] of Object.entries(meta)) parts.push(setMeta(k, v, now));
  parts.push("COMMIT;");
  run(dbPath, parts.join("\n"));
}

module.exports = { hasSqlite, createFresh, writeGraph, query, run, esc };
