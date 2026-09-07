"use strict";
/**
 * Orchestrates one full index: walk -> extract -> write. Always a full rebuild (the DB is
 * cheap to regenerate and the kit's overlays re-apply themselves via query.cjs self-heal).
 */
const path = require("path");
const config = require("./config");
const db = require("./db");
const { walk } = require("./walk");
const { extract } = require("./extract");
const pkg = require("../package.json");

function indexProject(root, opts = {}) {
  const log = opts.quiet ? () => {} : msg => process.stderr.write(`[codegraph] ${msg}\n`);
  if (!db.hasSqlite()) throw new Error("the `sqlite3` command-line tool is required (brew install sqlite / apt install sqlite3).");
  if (!config.isInitialized(root)) config.init(root);
  const cfg = config.load(root);
  const t0 = Date.now();
  const files = walk(root, cfg);
  log(`${files.length} source file(s) under ${root}`);
  const graph = extract(root, files, { extractDocstrings: cfg.extractDocstrings, recordUnresolved: !!opts.recordUnresolved });
  const t1 = Date.now();
  log(`extracted ${graph.nodes.length} nodes, ${graph.edges.length} edges in ${((t1 - t0) / 1000).toFixed(1)}s`);
  const dbPath = config.dbPath(root);
  db.createFresh(dbPath);
  const meta = {
    engine: pkg.name,
    engine_version: pkg.version,
    engine_dir: path.resolve(__dirname, ".."),
    root,
    tsconfig: graph.tsconfig || "",
    indexed_at: String(Date.now()),
    file_count: files.length,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
  };
  db.writeGraph(dbPath, graph, meta);
  const t2 = Date.now();
  log(`wrote ${dbPath} in ${((t2 - t1) / 1000).toFixed(1)}s (total ${((t2 - t0) / 1000).toFixed(1)}s)`);
  return { files: files.length, nodes: graph.nodes.length, edges: graph.edges.length, dbPath, ms: t2 - t0 };
}

function stats(root) {
  const dbPath = config.dbPath(root);
  const byKind = db.query(dbPath, "SELECT kind, count(*) c FROM nodes GROUP BY kind ORDER BY c DESC;");
  const edgeKinds = db.query(dbPath, "SELECT kind, coalesce(provenance,'native') provenance, count(*) c FROM edges GROUP BY kind, provenance ORDER BY c DESC;");
  const meta = db.query(dbPath, "SELECT key, value FROM project_metadata ORDER BY key;");
  const files = db.query(dbPath, "SELECT language, count(*) c FROM files GROUP BY language;");
  return { byKind, edgeKinds, meta, files };
}

module.exports = { indexProject, stats };
