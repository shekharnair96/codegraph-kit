#!/usr/bin/env node
"use strict";
/**
 * codegraph — build the knowledge-graph database the codegraph-kit MCP server queries.
 *
 *   codegraph init [path] [-i|--index]     create .codegraph/ (config + .gitignore); -i indexes too
 *   codegraph index [path] [-q|--quiet]    full (re)build of .codegraph/codegraph.db
 *   codegraph stats [path]                 node/edge counts by kind
 *   codegraph query <name> [path]          quick lookup: symbols named <name> (exact, then substring)
 *   codegraph version
 *
 * `path` defaults to the current directory. No global install needed: run it as
 * `node codegraph-ext/engine/bin/codegraph.js …` from the kit.
 */
const path = require("path");
const config = require("../lib/config");
const pkg = require("../package.json");

function usage(code = 0) {
  process.stdout.write(
    [
      `codegraph ${pkg.version} — knowledge-graph indexer for codegraph-kit`,
      "",
      "  codegraph init [path] [-i]      initialise .codegraph/ (add -i to index immediately)",
      "  codegraph index [path] [-q]     rebuild .codegraph/codegraph.db from source",
      "  codegraph stats [path]          counts by node/edge kind",
      "  codegraph query <name> [path]   look up symbols by name",
      "  codegraph version",
      "",
    ].join("\n")
  );
  process.exit(code);
}

function parse(argv) {
  return { flags: new Set(argv.filter(a => a.startsWith("-"))), positional: argv.filter(a => !a.startsWith("-")) };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) usage(0);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const { flags, positional } = parse(rest);
  const quiet = flags.has("-q") || flags.has("--quiet");

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(pkg.version + "\n");
    return;
  }
  if (cmd === "init") {
    const root = path.resolve(positional[0] || process.cwd());
    const r = config.init(root);
    if (!quiet) process.stdout.write(`${r.created ? "initialised" : "already initialised"}: ${r.dir}\n`);
    if (flags.has("-i") || flags.has("--index")) {
      const { indexProject } = require("../lib/index");
      const s = indexProject(root, { quiet });
      if (!quiet) process.stdout.write(`indexed ${s.files} files -> ${s.nodes} nodes, ${s.edges} edges (${(s.ms / 1000).toFixed(1)}s)\n`);
    }
    return;
  }
  if (cmd === "index") {
    const root = path.resolve(positional[0] || process.cwd());
    const { indexProject } = require("../lib/index");
    const s = indexProject(root, { quiet, recordUnresolved: flags.has("--unresolved") });
    if (!quiet) process.stdout.write(`indexed ${s.files} files -> ${s.nodes} nodes, ${s.edges} edges (${(s.ms / 1000).toFixed(1)}s)\n`);
    return;
  }
  if (cmd === "stats") {
    const root = path.resolve(positional[0] || process.cwd());
    const { stats } = require("../lib/index");
    const s = stats(root);
    if (flags.has("--json")) return process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    process.stdout.write("nodes by kind:\n");
    for (const r of s.byKind) process.stdout.write(`  ${String(r.c).padStart(7)}  ${r.kind}\n`);
    process.stdout.write("edges by kind:\n");
    for (const r of s.edgeKinds) process.stdout.write(`  ${String(r.c).padStart(7)}  ${r.kind}${r.provenance !== "native" ? ` (${r.provenance})` : ""}\n`);
    process.stdout.write("files by language:\n");
    for (const r of s.files) process.stdout.write(`  ${String(r.c).padStart(7)}  ${r.language}\n`);
    return;
  }
  if (cmd === "query") {
    const name = positional[0];
    if (!name) usage(1);
    const root = path.resolve(positional[1] || process.cwd());
    const db = require("../lib/db");
    const dbPath = config.dbPath(root);
    const esc = db.esc(name);
    let rows = db.query(dbPath, `SELECT kind,name,qualified_name,file_path,start_line,end_line,is_exported,signature FROM nodes WHERE name='${esc}' AND kind!='file' ORDER BY file_path;`);
    if (!rows.length) rows = db.query(dbPath, `SELECT kind,name,qualified_name,file_path,start_line,end_line,is_exported,signature FROM nodes WHERE name LIKE '%${esc}%' AND kind!='file' ORDER BY length(name), file_path LIMIT 25;`);
    if (flags.has("--json")) return process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    if (!rows.length) return process.stdout.write(`no symbol matching "${name}"\n`);
    for (const r of rows) process.stdout.write(`${r.name}  [${r.kind}]  ${r.file_path}:${r.start_line}-${r.end_line}${r.is_exported ? "  exported" : ""}${r.signature ? "  " + r.signature : ""}\n`);
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  usage(1);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[codegraph] error: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
