#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/query.cjs — thin query layer over the ext overlays.
 *
 * Usage:
 *   node codegraph-ext/query.cjs covers <source-path-substr>   who tests this source file
 *   node codegraph-ext/query.cjs mocks  <module-path-substr>   who mocks this module (+ which exports)
 *   node codegraph-ext/query.cjs props  <ComponentName>        prop shape of a component
 *   node codegraph-ext/query.cjs docs   <SymbolName>            signature + JSDoc summary + props
 *   node codegraph-ext/query.cjs impact <SymbolName>            FULL change set: def + refs + covering tests + literal-assert sites
 *   node codegraph-ext/query.cjs plan   <SymbolName> "<change>"  impact, formatted as a ready-to-paste, pre-scoped task prompt
 *   node codegraph-ext/query.cjs dedupe [symbol-substr]        mirrors / divergent / todo classifications
 *   node codegraph-ext/query.cjs notes  [search-substr]        conventions + decisions
 *   node codegraph-ext/query.cjs why    <source-path-substr>   annotations attached to a file
 *
 * The overlay self-heals: before every query, if the ext rows were wiped by a full
 * `codegraph index`, cascade-deleted by a `sync`, or annotations.json changed, this
 * silently re-runs augment.cjs. So overlays stay correct without any external hook.
 *
 * codegraph's native CLI does not know these custom edge kinds, so we query the SQLite directly.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APP_ROOT = path.join(__dirname, "..");
const DB = path.join(__dirname, "..", ".codegraph", "codegraph.db");
const AUGMENT = path.join(__dirname, "augment.cjs");
const ANNOTATIONS_FILE = path.join(__dirname, "annotations.json");
const esc = s => String(s).replace(/'/g, "''");
const q = sql => {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
};
// Paths printed by plan/impact/locate/read are meant to be fed straight back into codegraph_read /
// codegraph_apply. Abbreviating them (e.g. src/some/deep/dir/ -> …/) breaks that round-trip: the next
// tool can't open a '…/…' path. So emit the VERBATIM repo-relative path (strip only the 'file:'
// scheme prefix from KG rows). Display is a few chars longer; the copy-paste actually works.
const short = p => String(p).replace(/^file:/, "");

// ---------- HYDRATION: bounded, line-numbered source slice for a symbol span ----------
// We already hit disk for the single def line; returning the whole (capped) span in the SAME
// payload means the model doesn't need a follow-up codegraph_read to see the body. Cap HARD so we
// never re-introduce the whole-file token bomb — signature + head of body is enough to orient, and
// we tell the model exactly how to read the rest if it truly needs it.
function codeChunk(fileRel, startLine, endLine, { max = 40 } = {}) {
  try {
    const lines = fs.readFileSync(path.join(APP_ROOT, fileRel), "utf8").split("\n");
    const lo = Math.max(1, startLine || 1);
    const end = endLine || startLine || lo;
    let hi = Math.min(lines.length, end);
    let truncated = 0;
    if (hi - lo + 1 > max) {
      truncated = hi - (lo + max - 1);
      hi = lo + max - 1;
    }
    const out = [];
    for (let i = lo; i <= hi; i++) out.push(`${String(i).padStart(5)}  ${lines[i - 1] ?? ""}`);
    if (truncated > 0)
      out.push(`      … (+${truncated} more lines — codegraph_read ${fileRel}:${hi + 1}-${end} only if you truly need the rest)`);
    return out.join("\n");
  } catch (_) {
    return "";
  }
}
const indent = (s, pad = "        ") => s.split("\n").map(l => pad + l).join("\n");

// ---------- self-heal: re-augment if the overlay was wiped/cascade-deleted/annotations changed ----------
function metaVal(key) {
  const r = q(`SELECT value FROM project_metadata WHERE key='${esc(key)}';`);
  return r.length ? r[0].value : null;
}
function ensureFresh() {
  try {
    if (!fs.existsSync(DB)) return;
    const expected = metaVal("ext:edge_count");
    const hashStored = metaVal("ext:annotations_hash");
    const hashNow = crypto.createHash("md5").update(fs.readFileSync(ANNOTATIONS_FILE)).digest("hex");
    const actual = (q("SELECT count(*) c FROM edges WHERE provenance='ext';")[0] || {}).c;
    const stale = expected == null || String(actual) !== String(expected) || hashStored !== hashNow;
    if (stale) {
      process.stderr.write("[cg:ask] overlay stale/missing — re-augmenting…\n");
      execFileSync("node", [AUGMENT], { stdio: "ignore" });
    }
  } catch (e) {
    process.stderr.write(`[cg:ask] self-heal skipped: ${e.message}\n`);
  }
}

const [cmd, arg] = [process.argv[2], process.argv[3]];

function covers() {
  const rows = q(
    `SELECT e.source AS test FROM edges e JOIN nodes n ON n.id=e.target ` +
      `WHERE e.kind='covers' AND e.provenance='ext' AND n.file_path LIKE '%${esc(arg)}%' ORDER BY 1;`
  );
  console.log(`\n${rows.length} test file(s) cover *${arg}*:`);
  rows.forEach(r => console.log("  " + short(r.test)));
}

function mocks() {
  const rows = q(
    `SELECT e.source AS test, e.metadata FROM edges e JOIN nodes n ON n.id=e.target ` +
      `WHERE e.kind='mocks' AND e.provenance='ext' AND n.file_path LIKE '%${esc(arg)}%' ORDER BY 1;`
  );
  console.log(
    `\n${rows.length} test file(s) mock *${arg}*  (patch these factories when adding a barrel export):`
  );
  rows.forEach(r => {
    let exp = [];
    try {
      exp = JSON.parse(r.metadata).exports || [];
    } catch (_) {
      /* ignore */
    }
    console.log(
      "  " +
        short(r.test) +
        (exp.length ? `\n      exports: ${exp.join(", ")}` : "  (no factory / auto-mock)")
    );
  });
}

function props() {
  const rows = q(
    `SELECT n.name, n.qualified_name, n.signature, e.metadata FROM nodes n ` +
      `JOIN edges e ON e.target=n.id AND e.kind='has_prop' ` +
      `JOIN nodes c ON c.id=e.source ` +
      `WHERE n.kind='prop' AND (n.qualified_name LIKE '${esc(arg)}Props.%' OR c.name='${esc(arg)}') ORDER BY n.name;`
  );
  console.log(`\n${rows.length} prop(s) for *${arg}*:`);
  rows.forEach(r => {
    let optional = false;
    try {
      optional = JSON.parse(r.metadata).optional;
    } catch (_) {
      /* ignore */
    }
    console.log(`  ${r.name}${optional ? "?" : ""}${r.signature}`);
  });
}

function dedupe() {
  const filter = arg ? `AND e.metadata LIKE '%${esc(arg)}%'` : "";
  const rows = q(
    `SELECT e.kind, e.source, e.target, e.metadata FROM edges e ` +
      `WHERE e.provenance='ext' AND e.kind IN ('mirrors','divergent','todo') ${filter} ORDER BY e.kind;`
  );
  console.log(`\n${rows.length} dedupe classification(s):`);
  rows.forEach(r => {
    let m = {};
    try {
      m = JSON.parse(r.metadata);
    } catch (_) {
      /* ignore */
    }
    console.log(`  [${r.kind}/${m.status || "?"}] ${m.symbol || ""}`);
    console.log(`      ${short(r.source)}  <->  ${short(r.target)}`);
    if (m.rationale) console.log(`      ${m.rationale}`);
  });
}

function notes() {
  const filter = arg ? `AND (name LIKE '%${esc(arg)}%' OR docstring LIKE '%${esc(arg)}%')` : "";
  const rows = q(
    `SELECT qualified_name, signature, docstring FROM nodes WHERE kind='annotation' ${filter} ORDER BY qualified_name;`
  );
  console.log(`\n${rows.length} annotation(s):`);
  rows.forEach(r => {
    const body = (r.docstring || "").split("\n").slice(1).join(" ");
    console.log(`  • [${r.qualified_name}] ${r.signature}`);
    if (body) console.log(`      ${body}`);
  });
}

function why() {
  const rows = q(
    `SELECT a.qualified_name, a.signature FROM edges e ` +
      `JOIN nodes a ON a.id=e.source JOIN nodes f ON f.id=e.target ` +
      `WHERE e.kind='annotates' AND e.provenance='ext' AND f.file_path LIKE '%${esc(arg)}%' ORDER BY 1;`
  );
  console.log(`\n${rows.length} annotation(s) touching *${arg}*:`);
  rows.forEach(r => console.log(`  • [${r.qualified_name}] ${r.signature}`));
}

function docs() {
  const syms = q(
    `SELECT id, name, signature, file_path, docstring FROM nodes ` +
      `WHERE name='${esc(arg)}' AND kind IN ('function','method','class') ORDER BY file_path;`
  );
  if (!syms.length) {
    console.log(`\nno indexed symbol named *${arg}*`);
    return;
  }
  console.log(`\n${syms.length} symbol(s) named *${arg}*:`);
  syms.forEach(s => {
    const dr = q(
      `SELECT n.docstring FROM edges e JOIN nodes n ON n.id=e.source ` +
        `WHERE e.kind='documents' AND e.provenance='ext' AND e.target='${esc(s.id)}';`
    );
    const summary = (dr.length && dr[0].docstring) || s.docstring || "";
    console.log(`\n  ${s.name}  (${short(s.file_path)})`);
    if (s.signature) console.log(`    sig: ${s.signature}`);
    if (summary) console.log(`    doc: ${summary}`);
  });
  const props = q(
    `SELECT n.name, e.metadata FROM nodes n ` +
      `JOIN edges e ON e.target=n.id AND e.kind='has_prop' ` +
      `JOIN nodes c ON c.id=e.source ` +
      `WHERE n.kind='prop' AND (c.name='${esc(arg)}' OR n.qualified_name LIKE '${esc(arg)}Props.%') ORDER BY n.name;`
  );
  if (props.length) {
    console.log(`    props:`);
    props.forEach(p => {
      let o = false;
      try {
        o = JSON.parse(p.metadata).optional;
      } catch (_) {
        /* ignore */
      }
      console.log(`      - ${p.name}${o ? "?" : ""}`);
    });
  }
}

// ---------- grep helper (identifier / literal scan for what native ref edges miss) ----------
// grep exits 1 when there are no matches → execFileSync throws; we treat that as [].
const isTestFile = f => /\.test\.tsx?$/.test(f);
function grepLines(needle, { fixed = false, word = false, testsOnly = false, prodOnly = false, ignoreCase = false } = {}) {
  const args = ["-rnI", "--include=*.ts", "--include=*.tsx"];
  if (fixed) args.push("-F");
  if (word) args.push("-w");
  if (ignoreCase) args.push("-i");
  args.push(needle, "src");
  let out = "";
  try {
    out = execFileSync("grep", args, { cwd: APP_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return []; // no matches (exit 1) or grep error → empty
  }
  let rows = out.trim() ? out.trim().split("\n") : [];
  rows = rows
    .map(l => {
      const i = l.indexOf(":");
      const j = l.indexOf(":", i + 1);
      if (i < 0 || j < 0) return null;
      return { file: l.slice(0, i), line: Number(l.slice(i + 1, j)), text: l.slice(j + 1).trim() };
    })
    .filter(Boolean);
  if (testsOnly) rows = rows.filter(r => isTestFile(r.file));
  if (prodOnly) rows = rows.filter(r => !isTestFile(r.file));
  return rows;
}

// Pull the string/hex literals a symbol declares, so we can find tests that hard-code them.
// Heuristic (high-recall, verify): hex colors + quoted strings length>=3. Bare numbers are
// skipped on purpose — too noisy to match reliably.
function literalsInSpan(fileRel, startLine, endLine) {
  const abs = path.join(APP_ROOT, fileRel);
  let src = "";
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch (_) {
    return [];
  }
  const span = src
    .split("\n")
    .slice(Math.max(0, startLine - 1), endLine || startLine)
    .join("\n");
  const lits = new Set();
  const hex = span.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  hex.forEach(h => lits.add(h));
  const quoted = span.match(/(["'`])((?:\\.|(?!\1).){3,}?)\1/g) || [];
  quoted.forEach(qs => {
    const inner = qs.slice(1, -1);
    if (inner && !/^\s*$/.test(inner)) lits.add(inner);
  });
  return [...lits];
}

const uniqByLine = rows => {
  const seen = new Set();
  return rows.filter(r => {
    const k = r.file + ":" + r.line;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Gather the full edit set for a symbol: KG edges where they exist + a bounded scan for what
// native reference edges miss (constants especially). Returns structured data for impact/plan.
function gatherImpact(symbol) {
  const syms = q(
    `SELECT id, name, kind, file_path, start_line, end_line FROM nodes ` +
      `WHERE name='${esc(symbol)}' AND kind IN ('constant','function','method','class','variable','enum','enum_member') ORDER BY file_path;`
  );
  if (!syms.length) return { found: false, symbol };

  const defKeys = new Set(syms.map(s => `${s.file_path}:${s.start_line}`));
  const defFiles = [...new Set(syms.map(s => s.file_path))];

  // references: native calls/references edges (functions/hooks) + identifier grep (constants)
  let refs = [];
  for (const s of syms) {
    const nat = q(
      `SELECT n.file_path AS file, n.start_line AS line, n.name FROM edges e ` +
        `JOIN nodes n ON n.id=e.source ` +
        `WHERE e.kind IN ('references','calls') AND e.target='${esc(s.id)}';`
    );
    refs.push(...nat.map(r => ({ file: r.file, line: r.line, text: r.name || "", src: "kg" })));
  }
  const grepped = grepLines(symbol, { word: true, prodOnly: true }).map(r => ({ ...r, src: "scan" }));
  refs.push(...grepped);
  refs = uniqByLine(refs).filter(r => !defKeys.has(`${r.file}:${r.line}`));

  // covering tests: the covers overlay for each defining file
  let covering = [];
  for (const f of defFiles) {
    const rows = q(
      `SELECT e.source AS test FROM edges e ` +
        `WHERE e.kind='covers' AND e.provenance='ext' AND e.target='file:${esc(f)}' ORDER BY 1;`
    );
    covering.push(...rows.map(r => short(r.test)));
  }
  covering = [...new Set(covering)];

  // literal-assert sites: tests that hard-code the symbol's declared literals
  const literals = [];
  for (const s of syms) literals.push(...literalsInSpan(s.file_path, s.start_line, s.end_line));
  const lits = [...new Set(literals)];
  let asserts = [];
  for (const lit of lits) {
    grepLines(lit, { fixed: true, testsOnly: true }).forEach(r => asserts.push({ ...r, literal: lit }));
  }
  asserts = uniqByLine(asserts);

  return { found: true, symbol, syms, refs, covering, asserts, literals: lits };
}

function impact() {
  const r = gatherImpact(arg);
  if (!r.found) {
    console.log(`\nno indexed symbol named *${arg}* (constant/function/class/variable/enum).`);
    return;
  }
  console.log(`\n=== impact: ${r.symbol} ===`);
  console.log(`\ndefinition(s) — the single source of truth to edit (body hydrated below, no need to read the file):`);
  r.syms.forEach(s => {
    console.log(`  ${short(s.file_path)}:${s.start_line}  (${s.kind})`);
    const chunk = codeChunk(s.file_path, s.start_line, s.end_line);
    if (chunk) console.log(indent(chunk));
  });
  console.log(`\nproduction references (${r.refs.length}):`);
  r.refs.slice(0, 40).forEach(x => console.log(`  ${short(x.file)}:${x.line}  ${x.text}`));
  if (r.refs.length > 40) console.log(`  … +${r.refs.length - 40} more`);
  console.log(`\ncovering test file(s) (${r.covering.length}) — run only these to verify:`);
  r.covering.forEach(t => console.log(`  ${t}`));
  console.log(
    `\nliteral-assert sites (${r.asserts.length}) — tests hard-coding this symbol's literals [heuristic, verify]:`
  );
  r.asserts.slice(0, 40).forEach(x => console.log(`  ${short(x.file)}:${x.line}  «${x.literal}»`));
  if (r.asserts.length > 40) console.log(`  … +${r.asserts.length - 40} more`);
  if (r.literals.length) console.log(`\n  (literals scanned: ${r.literals.join(", ")})`);
}

function plan() {
  const rest = process.argv.slice(4).filter(a => a !== "--spec");
  const wantSpec = process.argv.includes("--spec");
  const change = rest.join(" ") || "<describe the change>";
  const r = gatherImpact(arg);
  if (!r.found) {
    console.log(`\nno indexed symbol named *${arg}*; cannot pre-scope. Fall back to grep + read.`);
    return;
  }

  // --spec: emit a machine-readable edit-spec skeleton for `cg:apply` (agent fills each "new").
  // Each entry's "old" is the CURRENT line text (exact anchor); "new" is a TODO placeholder.
  if (wantSpec) {
    const lineText = (fileRel, lineNo) => {
      try {
        const abs = path.join(APP_ROOT, fileRel);
        return fs.readFileSync(abs, "utf8").split("\n")[lineNo - 1] ?? "";
      } catch (_) {
        return "";
      }
    };
    const spec = [];
    for (const s of r.syms)
      spec.push({
        file: s.file_path,
        line: s.start_line,
        old: lineText(s.file_path, s.start_line),
        new: "<TODO>",
      });
    for (const a of r.asserts)
      spec.push({ file: a.file, line: a.line, old: lineText(a.file, a.line), new: "<TODO>" });
    console.log(JSON.stringify(spec, null, 2));
    console.log(
      `\n// ^ fill each "new", drop lines you don't need, then:  npm run cg:apply -- <this>.json` +
        `\n// note: assert sites are high-recall heuristics — verify before editing.`
    );
    return;
  }

  const lineTextP = (fileRel, lineNo) => {
    try {
      return (fs.readFileSync(path.join(APP_ROOT, fileRel), "utf8").split("\n")[lineNo - 1] ?? "").trim();
    } catch (_) {
      return "";
    }
  };
  const editSet = [
    ...r.syms.map(s => ({
      loc: `${short(s.file_path)}:${s.start_line}`,
      tag: `definition — ${s.kind}`,
      chunk: codeChunk(s.file_path, s.start_line, s.end_line),
      code: lineTextP(s.file_path, s.start_line),
    })),
    ...r.refs
      .slice(0, 40)
      .map(x => ({
        loc: `${short(x.file)}:${x.line}`,
        tag: "reference",
        code: (x.text || lineTextP(x.file, x.line)).trim(),
      })),
    ...r.asserts
      .slice(0, 40)
      .map((x, i) => ({
        loc: `${short(x.file)}:${x.line}`,
        tag: `test asserts «${x.literal}»`,
        // hydrate the first dozen assert sites with a tight 3-line window so the test-fix phase can
        // rewrite the assertion WITHOUT reading the test file; the rest stay as a single line.
        chunk: i < 12 ? codeChunk(x.file, x.line - 1, x.line + 1) : "",
        code: (x.text || lineTextP(x.file, x.line)).trim(),
      })),
  ];
  console.log(`\n----- paste the block below as the task prompt -----\n`);
  console.log(`TASK: ${change} (target symbol: ${r.symbol}).`);
  console.log(
    `\nEdit ONLY these sites (pre-computed via the knowledge graph — the current line is shown so you do NOT need to read these files):`
  );
  editSet.forEach(e => {
    console.log(`  - ${e.loc}  (${e.tag})`);
    if (e.chunk) console.log(indent(e.chunk));
    else if (e.code) console.log(`        ${e.code}`);
  });
  console.log(`\nRules:`);
  console.log(`  - Prefer editing the definition (single source of truth) over each call site.`);
  console.log(`  - Use anchored replace_in_file; do not rewrite whole files.`);
  console.log(`  - Update the test-assert sites above only if the change makes them fail.`);
  console.log(`  - Do NOT touch other features or unrelated files.`);
  console.log(
    `  - Verify once at the end with:  npm run cg:test -- ${r.covering.join(" ") || "<changed-file>"}`
  );
  console.log(
    `\n(note: reference/assert lists are high-recall heuristics — trust the definition, verify the rest.)`
  );
}

// ---------- locate: behavior/concept -> candidate symbols (the missing "rung 1") ----------
// The edit tools (plan/impact/read) all need a symbol you ALREADY know. Real tasks arrive as a
// BEHAVIOR ("make the graph series red"), not a symbol. locate bridges that gap by ranked FTS over
// the symbols' own names/qualified_names/docstrings/signatures — devs name things semantically
// (METRIC_SERIES_COLORS, PRIMARY_SERIES_FILL_OPACITY), so concept words land on the owning symbol.
// Then hand the winning name to codegraph_plan. No grep, no leaf-symbol knowledge required.
function readLine(fileRel, lineNo) {
  try {
    return (fs.readFileSync(path.join(APP_ROOT, fileRel), "utf8").split("\n")[lineNo - 1] ?? "").trim();
  } catch (_) {
    return "";
  }
}
// Structural skeleton for a located node: enclosing scope + direct edges (callers/covering tests)
// + a hydrated body chunk. Front-loads orientation so the model can act on the FIRST hit.
function skeletonFor(id, fileRel, startLine) {
  try {
    const self = q(`SELECT start_line, end_line FROM nodes WHERE id='${esc(id)}' LIMIT 1;`)[0] || { start_line: startLine };
    const parent = q(
      `SELECT name, kind FROM nodes WHERE file_path='${esc(fileRel)}' ` +
        `AND start_line < ${self.start_line} AND end_line >= ${self.end_line || self.start_line} ` +
        `AND kind IN ('function','method','class','interface','enum') ORDER BY (end_line-start_line) ASC LIMIT 1;`
    )[0];
const nrefs = (q(`SELECT count(DISTINCT source) c FROM edges WHERE kind IN ('references','calls') AND target='${esc(id)}';`)[0] || {}).c || 0;
    // WHO uses this symbol, BY NAME (not just a count) — answers the 'is this actually wired into X?'
    // question that otherwise sends the model on a locate/read hunt. Capped; names are ~free on tokens.
    const refRows = q(
      `SELECT DISTINCT n.name AS name, n.file_path AS file, n.start_line AS line ` +
        `FROM edges e JOIN nodes n ON n.id=e.source ` +
        `WHERE e.kind IN ('references','calls') AND e.target='${esc(id)}' ` +
        `AND n.name IS NOT NULL AND n.name != '' ORDER BY n.name LIMIT 7;`
    );
    const ntests = (q(
      `SELECT count(*) c FROM edges WHERE kind='covers' AND provenance='ext' AND target='file:${esc(fileRel)}';`
    )[0] || {}).c || 0;
    const lines = [];
    lines.push(
      `scope: ${parent ? `${parent.kind} ${parent.name} › ` : ""}${short(fileRel)}` +
        `   ${ntests} covering test file(s)`
    );
    if (nrefs) {
      const shown = refRows.slice(0, 6).map(r => `${r.name} (${short(r.file)}:${r.line})`);
      const more = nrefs - shown.length;
      lines.push(`      used by: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
    } else {
      lines.push(`      used by: (no references found in graph)`);
    }
    const chunk = codeChunk(fileRel, self.start_line, self.end_line);
    if (chunk) lines.push(chunk);
    return lines.join("\n");
  } catch (_) {
    return "";
  }
}
const BUILD_BODY = path.join(__dirname, "build-body-index.cjs");
const LOCATE_KINDS = "'constant','function','method','class','variable','enum','type_alias','interface'";
const NOT_TEST =
  "file_path NOT LIKE '%__tests__%' AND file_path NOT LIKE '%.test.%' " +
  "AND file_path NOT LIKE '%__mocks__%' AND file_path NOT LIKE '%e2e/%' AND file_path NOT LIKE '%.spec.%'";
// Rebuild the body index (node_body_fts) if it's missing or the node count drifted (a fresh
// `codegraph index` wipes custom tables). Cheap + dependency-free, so callers stay honest.
function ensureBodyIndex() {
  try {
    const has = q(`SELECT name FROM sqlite_master WHERE type='table' AND name='node_body_fts';`).length;
    const stored = metaVal("ext:body_index_nodes");
    const now = (q(`SELECT count(*) c FROM nodes WHERE kind IN (${LOCATE_KINDS}) AND start_line>0 AND language!='ext';`)[0] || {}).c;
    if (!has || stored == null || String(now) !== String(stored)) {
      process.stderr.write("[cg:locate] body index missing/stale — rebuilding…\n");
      execFileSync("node", [BUILD_BODY], { stdio: "ignore" });
    }
  } catch (e) {
    process.stderr.write(`[cg:locate] body-index check skipped: ${e.message}\n`);
  }
}
function locate() {
  const query = process.argv.slice(3).join(" ").trim();
  if (!query) {
    console.log("`locate` needs a search query, e.g.  locate graph series color");
    return;
  }
  const isHex = /^#?[0-9a-f]{3,8}$/i;
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9#]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
  const hexes = terms.filter(t => isHex.test(t) && /[a-f]/i.test(t) && t.length >= 4);
  const words = [...new Set(terms.filter(t => !hexes.includes(t)).map(t => t.replace(/[^a-z0-9]/gi, "")).filter(Boolean))];

  // ---- literal (hex) fast-path: grep the color, map to enclosing symbol ----
  const litHits = [];
  for (const h of hexes) {
    grepLines(h.startsWith("#") ? h : `#${h}`, { fixed: true, prodOnly: true, ignoreCase: true }).forEach(g => {
      const owner = q(
        `SELECT name, kind, file_path AS file, start_line AS line FROM nodes ` +
          `WHERE file_path='${esc(g.file)}' AND start_line<=${g.line} AND end_line>=${g.line} ` +
          `AND kind IN ('constant','function','method','class','variable') ORDER BY (end_line-start_line) ASC LIMIT 1;`
      );
      if (owner.length) litHits.push({ ...owner[0], literal: g.text });
    });
  }

  // ---- candidate gathering: name/doc/sig FTS  +  BODY-token FTS ----
  const cand = new Map(); // id -> {name,kind,file,line,exported, nameHit, bodyTerms:Set}
  const add = (r, patch) => {
    const cur = cand.get(r.id) || { ...r, nameHit: false, bodyTerms: new Set() };
    Object.assign(cur, patch, { bodyTerms: cur.bodyTerms });
    cand.set(r.id, cur);
  };
  if (words.length) {
    const match = esc(words.map(t => `${t}*`).join(" OR "));
    q(
      `SELECT n.id, n.kind, n.name, n.file_path AS file, n.start_line AS line, n.is_exported AS exported ` +
        `FROM nodes_fts f JOIN nodes n ON n.rowid=f.rowid ` +
        `WHERE nodes_fts MATCH '${match}' AND n.kind IN (${LOCATE_KINDS}) AND n.${NOT_TEST} ` +
        `ORDER BY rank LIMIT 40;`
    ).forEach(r => add(r, { nameHit: true }));

    ensureBodyIndex();
    for (const t of words) {
      q(
        `SELECT n.id, n.kind, n.name, n.file_path AS file, n.start_line AS line, n.is_exported AS exported ` +
          `FROM node_body_fts b JOIN nodes n ON n.rowid=b.rowid_ref ` +
          `WHERE node_body_fts MATCH '${esc(t)}*' AND n.kind IN (${LOCATE_KINDS}) AND n.${NOT_TEST} LIMIT 60;`
      ).forEach(r => {
        add(r, {});
        cand.get(r.id).bodyTerms.add(t);
      });
    }
  }

  // ---- score: DISTINCT-TERM COVERAGE first (a symbol matching series+width+stroke beats one that
  // only name-matches "series"); name-matched terms weigh more than body-only; then export/kind. ----
  // LEXICAL TIER (added after T4): when the query IS an identifier, an exact name match must outrank
  // a prefix match, and a prefix must outrank a mere substring. Without this, renaming ColumnConfig
  // returned ColumnConfigItem/Labels/Type and a same-named interface while the actual component fell
  // out of the top 5 -- every ColumnConfig* name ties on coverage, so FTS rank decided the order.
  // Deliberately lexical: this is a string-equality problem, and an embedding-side fix would trade
  // one ranking surprise for a subtler one.
  const qIdent = query.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const queryIsIdent = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query.trim());
  // Only let kind break ties when the query actually names a kind.
  const KIND_WORDS = { component: ["function", "class"], interface: ["interface"], type: ["type_alias"],
                       constant: ["constant"], function: ["function"], hook: ["function"] };
  const wantedKinds = new Set(words.flatMap(w => KIND_WORDS[w] || []));
  const lexTier = name => {
    if (!queryIsIdent) return 0;
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n === qIdent) return 3;        // exact
    if (n.startsWith(qIdent)) return 2; // prefix (ColumnConfigItem for query ColumnConfig)
    if (n.includes(qIdent)) return 1;   // substring
    return 0;
  };
  const scored = [...cand.values()]
    .map(c => {
      const hay = `${c.name} ${c.file}`.toLowerCase();
      const nameTerms = new Set(words.filter(t => hay.includes(t)));
      const bodyTerms = c.bodyTerms;
      const covered = new Set([...nameTerms, ...bodyTerms]);
      const cov = covered.size;
      const need = Math.min(2, words.length);
      // keep only real signal: a name-index hit, OR coverage of >=need distinct query terms
      if (!c.nameHit && cov < need) return null;
      const kindBonus = wantedKinds.size && wantedKinds.has(c.kind) ? 6 : 0;
      const score = lexTier(c.name) * 1000 + cov * 100 + nameTerms.size * 12 +
                    bodyTerms.size * 4 + kindBonus + (Number(c.exported) ? 3 : 0);
      return { ...c, score, cov, why: nameTerms.size >= bodyTerms.size ? "name" : "body" };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!scored.length && !litHits.length) {
    console.log(`\nlocate: no symbol matched *${query}*. Try broader concept words, or grep.`);
    return;
  }
  console.log(`\n=== locate: ${query} ===`);
  if (scored.length) {
    // CONFIDENCE SIGNAL: give the model the two cues it can't infer from a ranked list — (a) 'this is
    // clearly THE one, stop searching' and (b) 'the name you typed doesn't exist, you're guessing'.
    // The robust discriminator is EXACT-IDENTIFIER match: concept words always fuzzy-match something,
    // so score/name-hit heuristics misfire — but 'did the model type a real symbol name?' is crisp.
const isIdentQuery = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query.trim());
    const qn = query.trim().toLowerCase().replace(/[_$]/g, "");
    const exact = scored.find(s => s.name.toLowerCase().replace(/[_$]/g, "") === qn);
    const top = scored[0];
    const second = scored[1];
    // A concept query is 'answered' when: the model actually typed the top hit's NAME among the concept
    // words (e.g. 'getMetricColors primary comparison hex color map' -> getMetricColors), OR the #1 hit
    // covers every distinct term, OR it plainly dominates #2. The name-in-query path catches the model's
    // noisy real queries without firing on widget-prefixed guesses (whose words are NOT a real symbol name).
    const wordCount = words.length;
    const topNorm = top.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const namedInQuery = words.some(w => w.length >= 5 && w === topNorm);
    const conceptStrong =
      !isIdentQuery &&
      top.nameHit &&
      (namedInQuery || (wordCount && top.cov >= wordCount) || !second || top.score >= 1.4 * second.score);
    if (isIdentQuery && exact) {
      console.log(
        `\n>> STRONG MATCH: ${exact.name} (${short(exact.file)}:${exact.line}) — exact name hit; trust it, go straight to codegraph_plan or edit.`
      );
    } else if (isIdentQuery && !exact) {
      console.log(`\n>> NO EXACT-NAME MATCH: "${query}" is not an indexed symbol — you're guessing a name that doesn't exist.`);
      console.log(
        `   The thing you want likely lives in a SHARED helper (a shared config/util module) under a different name.` +
          ` Trace outward from the feature: codegraph_trace(entry="<feature dir>", concept="<what>").`
      );
    } else if (conceptStrong) {
      console.log(
        `\n>> STRONG MATCH: ${top.name} (${short(top.file)}:${top.line}) — best hit for your concept; trust it, go to codegraph_plan or edit (stop searching).`
      );
    }
    console.log(`\ncandidate symbols (ranked) — hand the best one to codegraph_plan:`);
    scored.forEach((r, i) => {
      console.log(`  ${r.name}  [${r.kind}]  ${short(r.file)}:${r.line}  (via ${r.why})`);
      // Top 2 get a STRUCTURAL SKELETON (enclosing scope + used-by names + a hydrated body chunk) so
      // the model can decide/edit WITHOUT a follow-up plan/read; the tail stays one line to save tokens.
      if (i < 2) {
        const skel = skeletonFor(r.id, r.file, r.line);
        if (skel) console.log(indent(skel, "      "));
      } else {
        const code = readLine(r.file, r.line);
        if (code) console.log(`        ${code}`);
      }
    });
    console.log(`\n(top ${Math.min(2, scored.length)} include enclosing scope + used-by + a hydrated body — trust them; codegraph_plan only for the covering-test / assert edit set.)`);
  }
  if (litHits.length) {
    const seen = new Set();
    const uniq = litHits.filter(h => (seen.has(h.name) ? false : seen.add(h.name)));
    console.log(`\nsymbols owning the literal(s):`);
    uniq.forEach(h => console.log(`  ${h.name}  [${h.kind}]  ${short(h.file)}:${h.line}`));
  }
  console.log(`\n→ next: codegraph_plan(symbol=<name>, change="…") to get the exact edit set.`);
}

// ---------- swap: one-shot literal value change (locate->plan->read->apply collapsed) ----------
// For the ultra-common "change this constant/color/number" task. Given a SYMBOL and an exact
// old->new value, it edits only WITHIN that symbol's definition span (so `#07A093` swaps the one metric's color
// alone, never the other metrics) PLUS the covering-test literal-assert lines that hard-code
// the same old value. This is the primitive that saves weaker models the read-spiral: no anchors
// to hand-build, no whole-file reads, no risk of over-broad find/replace.
//   node query.cjs swap <SymbolName> <oldValue> <newValue> [--tests]
function swap() {
  const symbol = process.argv[3];
  const oldVal = process.argv[4];
  const newVal = process.argv[5];
  const withTests = process.argv.includes("--tests");
  if (!symbol || oldVal == null || newVal == null) {
    console.log('swap needs: swap <Symbol> <oldValue> <newValue> [--tests]');
    process.exit(1);
  }
  if (String(oldVal).length < 2) {
    console.log(`refusing to swap too-short/ambiguous value "${oldVal}" (would over-match). Use codegraph_plan + codegraph_apply for this one.`);
    process.exit(1);
  }
  const r = gatherImpact(symbol);
  if (!r.found) {
    console.log(`\nno indexed symbol named *${symbol}*; cannot swap. Use codegraph_locate first.`);
    process.exit(1);
  }
  const edits = []; // {file, line, before, after}
  const fileCache = new Map();
  const readFileLines = fileRel => {
    if (!fileCache.has(fileRel)) {
      const abs = path.join(APP_ROOT, fileRel);
      fileCache.set(fileRel, fs.readFileSync(abs, "utf8").split("\n"));
    }
    return fileCache.get(fileRel);
  };
  // 1) production edits: only lines INSIDE the symbol's definition span(s) that contain oldVal
  for (const s of r.syms) {
    let lines;
    try { lines = readFileLines(s.file_path); } catch (_) { continue; }
    for (let ln = s.start_line; ln <= (s.end_line || s.start_line); ln++) {
      const cur = lines[ln - 1];
      if (cur != null && cur.includes(oldVal)) {
        const after = cur.split(oldVal).join(newVal);
        edits.push({ file: s.file_path, line: ln, before: cur, after });
        lines[ln - 1] = after;
      }
    }
  }
  // 2) test edits (opt-in): only the pre-computed literal-assert lines that hard-code oldVal
  if (withTests) {
    for (const a of r.asserts) {
      let lines;
      try { lines = readFileLines(a.file); } catch (_) { continue; }
      const cur = lines[a.line - 1];
      if (cur != null && cur.includes(oldVal)) {
        const after = cur.split(oldVal).join(newVal);
        edits.push({ file: a.file, line: a.line, before: cur, after });
        lines[a.line - 1] = after;
      }
    }
  }
  if (!edits.length) {
    console.log(`\nno occurrences of "${oldVal}" found inside ${symbol}'s definition span` + (withTests ? " or its assert sites" : "") + `.\n(Value may live in a called helper, not the symbol body — try codegraph_plan, or a different symbol.)`);
    process.exit(1);
  }
  // write changed files
  const changed = new Set(edits.map(e => e.file));
  for (const f of changed) fs.writeFileSync(path.join(APP_ROOT, f), fileCache.get(f).join("\n"));
  console.log(`\n=== swap: ${symbol}  "${oldVal}" -> "${newVal}" ===`);
  console.log(`\napplied ${edits.length} edit(s) across ${changed.size} file(s):`);
  edits.forEach(e => {
    console.log(`  ${short(e.file)}:${e.line}`);
    console.log(`    - ${e.before.trim()}`);
    console.log(`    + ${e.after.trim()}`);
  });
  if (!withTests && r.asserts.length) {
    console.log(`\nnote: ${r.asserts.length} test-assert site(s) hard-code this symbol's literals — re-run with --tests to swap matching ones, or verify and fix.`);
  }
  console.log(`\nnext: codegraph_verify to confirm the affected tests still pass.`);
}

// ---------- trace: FORWARD reachability (entry -> ... -> shared symbol) ----------
// The missing DOWNWARD primitive. locate/impact answer name-lookup and REVERSE refs ('who uses X');
// trace answers 'what does this feature/symbol REACH' — following calls/references OUT from an entry
// (a symbol name OR a file/path prefix) up to N hops, optionally filtered to paths that reach a
// CONCEPT (e.g. 'color'). Kills the guess-a-feature-local-constant spiral: the model asks 'does
// this widget reach the primary color?' and gets the exact chain instead of inventing fake names.
//   node query.cjs trace <SymbolOrPathPrefix> [--concept <words>] [--depth N]
function trace() {
  const raw = process.argv.slice(3).filter(a => a !== undefined);
  const ci = raw.indexOf("--concept");
  const di = raw.indexOf("--depth");
  let depth = 3;
  if (di !== -1 && raw[di + 1]) depth = Math.max(1, Math.min(5, parseInt(raw[di + 1], 10) || 3));
  let concept = null;
  if (ci !== -1) {
    // concept words = everything after --concept up to the next flag
    const rest = raw.slice(ci + 1).filter(a => !a.startsWith("--"));
    concept = rest.join(" ").toLowerCase().split(/[^a-z0-9]+/i).filter(t => t.length >= 2);
    if (!concept.length) concept = null;
  }
  const entry = raw.filter((a, i) => !a.startsWith("--") && raw[i - 1] !== "--concept" && raw[i - 1] !== "--depth")[0];
  if (!entry) {
    console.log('trace needs: trace <SymbolOrPathPrefix> [--concept <words>] [--depth N]');
    process.exit(1);
  }
  // ---- resolve roots: path-like -> exported nodes in matching files; else -> nodes by name ----
  const pathLike = /[/.]/.test(entry) && !/^[A-Z][A-Za-z0-9_]*$/.test(entry);
  let roots;
  if (pathLike) {
    const like = esc(entry.replace(/^\.?\//, ""));
    roots = q(
      `SELECT id, name, kind, file_path AS file, start_line AS line FROM nodes ` +
        `WHERE file_path LIKE '%${like}%' AND kind IN ('function','method','class') AND ${NOT_TEST} ` +
        `AND is_exported=1 ORDER BY (end_line-start_line) DESC LIMIT 12;`
    );
  } else {
    roots = q(
      `SELECT id, name, kind, file_path AS file, start_line AS line FROM nodes ` +
        `WHERE name='${esc(entry)}' AND kind IN (${LOCATE_KINDS}) AND ${NOT_TEST} LIMIT 6;`
    );
  }
  if (!roots.length) {
    console.log(`\ntrace: no ${pathLike ? "exported symbols under path" : "symbol named"} *${entry}*. Try codegraph_locate.`);
    process.exit(1);
  }
  const nodeById = id => q(`SELECT id, name, kind, file_path AS file, start_line AS line FROM nodes WHERE id='${esc(id)}' LIMIT 1;`)[0];
  const outEdges = id =>
    q(`SELECT DISTINCT target FROM edges WHERE source='${esc(id)}' AND kind IN ('calls','references') LIMIT 20;`).map(r => r.target);
  const conceptHit = n => concept && concept.some(t => (`${n.name} ${n.file}`).toLowerCase().includes(t));
  // ---- BFS out to `depth`, collecting root->leaf chains (dedup by terminal node) ----
  const MAX_NODES = 400;
  const MAX_PATHS = 25;
  const paths = [];
  const seenTerminal = new Set();
  let visited = 0;
  const walk = (id, chain, d) => {
    if (visited > MAX_NODES || paths.length >= MAX_PATHS) return;
    const n = nodeById(id);
    if (!n) return;
    visited++;
    const nextChain = [...chain, n];
    const isConceptLeaf = conceptHit(n) && chain.length > 0;
    const outs = d > 0 ? outEdges(id).filter(t => !chain.some(c => c.id === t)) : [];
    // record a path if: we hit the concept (filter mode), OR (no filter) we reached a leaf/max depth
    if (concept) {
      if (isConceptLeaf) {
        const key = n.id + "@" + nextChain.length;
        if (!seenTerminal.has(key)) { seenTerminal.add(key); paths.push(nextChain); }
      }
    } else if (d === 0 || !outs.length) {
      if (nextChain.length > 1 && !seenTerminal.has(n.id)) { seenTerminal.add(n.id); paths.push(nextChain); }
    }
    for (const t of outs) walk(t, nextChain, d - 1);
  };
  for (const r of roots) walk(r.id, [], depth);

  console.log(`\n=== trace: ${entry}${concept ? `  ->  concept «${concept.join(" ")}»` : ""}  (depth ${depth}) ===`);
  if (!paths.length) {
    console.log(
      concept
        ? `\nno path from ${entry} reaches «${concept.join(" ")}» within ${depth} hops.` +
            ` Increase --depth, or the wiring may go through a prop/JSX edge the graph doesn't track.`
        : `\nno outgoing calls/references from ${entry} within ${depth} hops.`
    );
    return;
  }
  console.log(`\n${paths.length} reachable chain(s)${concept ? ` ending at the concept` : ""}:`);
  paths.forEach(ch => {
    const line = ch
      .map((n, i) => (i === ch.length - 1 ? `${n.name} [${n.kind}] ${short(n.file)}:${n.line}` : n.name))
      .join("  ->  ");
    console.log(`  ${line}`);
  });
  console.log(`\n(hand the terminal symbol to codegraph_plan, or edit it directly.)`);
}

const table = { covers, mocks, props, docs, impact, plan, dedupe, notes, why, locate, swap, trace };
if (!table[cmd]) {
console.log("commands: locate | trace | covers | mocks | props | docs | impact | plan | dedupe | notes | why");
  process.exit(cmd ? 1 : 0);
}
if (["covers", "mocks", "props", "docs", "impact", "plan", "why"].includes(cmd) && !arg) {
  console.error(`\`${cmd}\` needs an argument.`);
  process.exit(1);
}
ensureFresh();
table[cmd]();
