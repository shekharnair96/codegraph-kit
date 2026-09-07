#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * cg-graph.cjs  —  Interactive change-impact graph from the CodeGraph DB.
 *
 * Turns a code change into a self-contained, interactive HTML page: nodes are
 * files / functions / methods / classes / constants / props; edges are
 * calls / references / imports / covers (test->src) / mocks / has_prop.
 * Changed symbols are highlighted; you can filter edge kinds, search, and click a
 * node to see its file:line, signature and docstring.
 *
 * Usage:
 *   node cg-graph.cjs --db <path/.codegraph/codegraph.db> \
 *        [--seed Name1,Name2]        symbols to center on (name or node id)
 *        [--changed Name1,Name2]     subset to mark "changed" (default = seeds)
 *        [--repo <dir> --diff]       derive changed FILES from `git diff --name-only`
 *        [--repo <dir> --pr]         PR mode: diff the branch vs its base and color nodes
 *                                    added / modified / deleted (symbol-level via hunks)
 *        [--base <ref>]              base ref for --pr (default: auto origin/main|master|main|master)
 *        [--hops N]                  neighborhood radius over semantic edges (default 2)
 *        [--inline]                  embed Cytoscape so the HTML works offline
 *        [--verify]                  after writing, assert the page is runnable (body JS parses,
 *                                    DATA/META are valid JSON) — exits non-zero if not
 *        [--verify-render]           also load the file in headless Chrome (needs @playwright/test;
 *                                    pass --playwright <dir> to point at a node_modules) and assert
 *                                    the graph actually renders (#cy canvas present, no pageerror)
 *        [--out <file.html>]         output (default cg-graph.html)
 *
 * Only "semantic" edges expand the neighborhood (calls/references/covers/mocks/
 * has_prop/documents/mirrors/divergent). Structural edges (contains/imports) are
 * shown between already-included nodes but never used to explode the graph.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : (argv.includes(k) ? true : d);
};
const DB = arg("--db");
if (!DB || !fs.existsSync(DB)) {
  console.error("cg-graph: --db <path to .codegraph/codegraph.db> is required and must exist");
  process.exit(1);
}
const HOPS = parseInt(arg("--hops", "2"), 10);
const OUT = arg("--out", "cg-graph.html");
const seedArg = (arg("--seed", "") || "").split(",").map(s => s.trim()).filter(Boolean);
let changedArg = (arg("--changed", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const repo = arg("--repo");
const prMode = argv.includes("--pr");
const base = arg("--base"); // explicit base ref for --pr (else auto-detect)
const useDiff = argv.includes("--diff") || prMode;

const SEMANTIC = new Set(["calls", "references", "covers", "mocks", "has_prop", "documents", "mirrors", "divergent"]);

// ---------- load graph ----------
const q = sql => {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
};
const nodes = new Map();
for (const r of q(
  "SELECT id,kind,name,qualified_name,file_path,start_line,end_line,signature,docstring FROM nodes;"
)) nodes.set(r.id, r);
const edges = q("SELECT source,target,kind,metadata FROM edges;");

// adjacency (both directions) restricted to semantic edges for expansion
const adj = new Map();
for (const e of edges) {
  if (!SEMANTIC.has(e.kind)) continue;
  (adj.get(e.source) || adj.set(e.source, []).get(e.source)).push(e.target);
  (adj.get(e.target) || adj.set(e.target, []).get(e.target)).push(e.source);
}

// map file_path -> containing "file" node id, and symbol -> its file node
const fileNodeByPath = new Map();
for (const [id, n] of nodes) if (n.kind === "file") fileNodeByPath.set(n.file_path, id);

// ---------- resolve seeds ----------
function resolveByNameOrId(tok) {
  if (nodes.has(tok)) return [tok];
  const hits = [];
  for (const [id, n] of nodes) if (n.name === tok && n.kind !== "file") hits.push(id);
  return hits;
}
let seeds = new Set();
for (const s of seedArg) resolveByNameOrId(s).forEach(id => seeds.add(id));

// ---------- derive changes from git (working tree, or a branch/PR range) ----------
let changedFiles = new Set();          // src-relative paths that changed
const fileStatus = new Map();          // srcRel -> 'added' | 'modified' | 'deleted'
const changeStatus = new Map();        // node id -> 'added' | 'modified'
const deletedSynthetic = [];           // [{path,status}] files not present in the current DB
let baseRef = null;
const git = a => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const toSrcRel = p => p.replace(/^.*?(src\/.*)$/, "$1");
function overlaps(a1, a2, b1, b2) { return a1 <= b2 && b1 <= a2; }

if (useDiff && repo) {
  // pick the diff range
  let range = null; // null => working-tree diff
  if (prMode) {
    const cands = base ? [base] : ["origin/main", "origin/master", "main", "master"];
    for (const c of cands) {
      try { baseRef = git(["merge-base", "HEAD", c]).trim() && c; if (baseRef) { range = c + "...HEAD"; break; } }
      catch (_) { /* try next */ }
    }
  }
  // name-status
  let ns = "";
  try { ns = git(["diff", "--relative", "--name-status", ...(range ? [range] : [])]); }
  catch (_) { ns = ""; }
  for (const line of ns.split("\n").map(s => s.trim()).filter(Boolean)) {
    const parts = line.split(/\t/);
    const code = parts[0][0]; // A M D R C
    const p = code === "R" || code === "C" ? parts[parts.length - 1] : parts[1];
    if (!p) continue;
    const srcRel = toSrcRel(p);
    if (!srcRel.startsWith("src/")) continue; // only indexed source lives in the code graph
    if (code === "D") { fileStatus.set(srcRel, "deleted"); deletedSynthetic.push({ path: srcRel, status: "deleted" }); continue; }
    const status = code === "A" ? "added" : "modified";
    fileStatus.set(srcRel, status); changedFiles.add(srcRel);
    // changed line ranges on the new side (for symbol-level modified detection)
    const ranges = [];
    if (status === "modified") {
      try {
        const hunks = git(["diff", "--relative", "-U0", ...(range ? [range] : []), "--", p]);
        for (const m of hunks.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)) {
          const start = +m[1], cnt = m[2] === undefined ? 1 : +m[2];
          if (cnt > 0) ranges.push([start, start + cnt - 1]);
        }
      } catch (_) { /* whole-file fallback below */ }
    }
    // classify symbols in this file
    for (const [id, n] of nodes) {
      if (n.kind === "file" || !n.file_path || !n.file_path.endsWith(srcRel)) continue;
      if (status === "added") { changeStatus.set(id, "added"); seeds.add(id); continue; }
      const hit = ranges.length === 0 /* couldn't diff -> treat all as modified */
        || ranges.some(([a, b]) => overlaps(n.start_line || 0, n.end_line || n.start_line || 0, a, b));
      if (hit) { changeStatus.set(id, "modified"); seeds.add(id); }
    }
  }
}

// legacy: explicit --seed / --changed still work (marked as 'modified')
if (!changedArg.length && !useDiff) changedArg = [...seeds].map(id => nodes.get(id)?.name).filter(Boolean);
for (const c of changedArg) resolveByNameOrId(c).forEach(id => { seeds.add(id); if (!changeStatus.has(id)) changeStatus.set(id, "modified"); });
[...seeds].forEach(id => { if (!changeStatus.has(id)) changeStatus.set(id, "modified"); });

// added files the current DB doesn't know about yet (index predates them) -> synthetic file nodes
for (const [srcRel, status] of fileStatus) {
  if (status !== "added") continue;
  const known = fileNodeByPath.has(srcRel) || [...seeds].some(id => nodes.get(id)?.file_path?.endsWith(srcRel));
  if (!known) deletedSynthetic.push({ path: srcRel, status: "added" });
}

if (!seeds.size && !deletedSynthetic.length) {
  console.error("cg-graph: nothing to show. Pass --seed <symbol>, or --repo <dir> with --diff / --pr.");
  process.exit(1);
}

// ---------- BFS neighborhood over semantic edges ----------
const included = new Set(seeds);
let frontier = [...seeds];
for (let h = 0; h < HOPS; h++) {
  const next = [];
  for (const id of frontier) for (const nb of adj.get(id) || []) if (!included.has(nb)) { included.add(nb); next.push(nb); }
  frontier = next;
}
// add the containing file node for each included symbol (context, no sibling expansion)
for (const id of [...included]) {
  const n = nodes.get(id);
  if (n && n.kind !== "file" && n.file_path) {
    const fid = fileNodeByPath.get(n.file_path);
    if (fid) included.add(fid);
  }
}
// include tests that COVER/MOCK any changed file (surfaces test-impact linkage)
const includedFileNodes = new Set([...included].filter(id => nodes.get(id)?.kind === "file"));
for (const e of edges) {
  if ((e.kind === "covers" || e.kind === "mocks") && includedFileNodes.has(e.target)) included.add(e.source);
}

// ---------- build cytoscape elements ----------
const elNodes = [];
for (const id of included) {
  const n = nodes.get(id);
  if (!n) continue;
  let change = changeStatus.get(id) || "";
  if (!change && n.kind === "file") { const s = fileStatus.get(toSrcRel(n.file_path || "")); if (s && s !== "deleted") change = s; }
  elNodes.push({ data: {
    id, label: n.name || (n.file_path ? path.basename(n.file_path) : id),
    kind: n.kind, file: n.file_path || "", line: n.start_line || 0,
    sig: (n.signature || "").slice(0, 300), doc: (n.docstring || "").slice(0, 400),
    change, seed: seeds.has(id) ? 1 : 0,
  }});
}
// synthetic nodes for files absent from the current DB (deleted, or added-before-reindex)
for (const d of deletedSynthetic) {
  const note = d.status === "deleted" ? "(file deleted in this change)" : "(file added; re-index for symbol-level detail)";
  elNodes.push({ data: { id: d.status + ":" + d.path, label: path.basename(d.path), kind: "file",
    file: d.path, line: 0, sig: "", doc: note, change: d.status, seed: 0 } });
}
const elEdges = [];
const seenE = new Set();
for (const e of edges) {
  if (!included.has(e.source) || !included.has(e.target)) continue;
  const key = e.source + ">" + e.target + ">" + e.kind;
  if (seenE.has(key)) continue; seenE.add(key);
  elEdges.push({ data: { id: "e" + seenE.size, source: e.source, target: e.target, kind: e.kind } });
}

const tally = s => elNodes.filter(n => n.data.change === s).length;
const meta = {
  db: DB, hops: HOPS, mode: prMode ? "pr" : (useDiff ? "diff" : "seed"), base: baseRef,
  seeds: [...seeds].map(id => nodes.get(id)?.name).filter(Boolean).slice(0, 12),
  changedFiles: [...fileStatus.entries()].map(([f, s]) => ({ file: f, status: s })),
  changes: { added: tally("added"), modified: tally("modified"), deleted: tally("deleted") },
  counts: { nodes: elNodes.length, edges: elEdges.length },
  edgeKinds: [...new Set(elEdges.map(e => e.data.kind))].sort(),
};

// ============================ HTML TEMPLATE ============================
const TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CodeGraph — change-impact graph</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.js"></script>
<style>
  :root{--bg:#0f172a;--panel:#111827;--ink:#e5e7eb;--muted:#94a3b8;--line:#1f2937}
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
    font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
  #app{display:grid;grid-template-columns:250px 1fr 300px;height:100vh}
  .panel{background:var(--panel);border-right:1px solid var(--line);padding:14px;overflow:auto}
  .panel.right{border-right:0;border-left:1px solid var(--line)}
  h1{font-size:15px;margin:0 0 4px} h2{font-size:12px;text-transform:uppercase;color:var(--muted);
    letter-spacing:.05em;margin:16px 0 6px}
  #cy{height:100vh}
  label.chk{display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer}
  .swatch{width:12px;height:12px;border-radius:3px;display:inline-block}
  input[type=search]{width:100%;padding:6px 8px;background:#0b1220;border:1px solid var(--line);
    color:var(--ink);border-radius:6px}
  button{background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;margin:2px 0}
  button.sec{background:#374151}
  .kv{font-size:12px;color:var(--muted)} .kv b{color:var(--ink)}
  pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;border:1px solid var(--line);
    border-radius:6px;padding:8px;font-size:12px;max-height:40vh;overflow:auto}
  .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .legend div{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px}
  a{color:#60a5fa}
</style></head>
<body><div id="app">
  <div class="panel left">
    <h1>Change-impact graph</h1>
    <div class="kv" id="summary"></div>
    <h2>Search</h2>
    <input id="q" type="search" placeholder="filter nodes by name…"/>
    <h2>Edge types</h2>
    <div id="edgeFilters"></div>
    <h2>View</h2>
    <label class="chk"><input type="checkbox" id="hideStruct" checked/> hide imports/contains</label>
    <button id="fit" class="sec">Fit</button>
    <button id="relayout">Re-layout</button>
    <h2>Legend</h2>
    <div class="legend" id="legend"></div>
  </div>
  <div id="cy"></div>
  <div class="panel right">
    <h1>Details</h1>
    <div id="detail" class="kv">Click a node…</div>
  </div>
</div>
<script>
const DATA = /*__ELEMENTS__*/;
const META = /*__META__*/;
const KIND_COLOR = {file:'#64748b',function:'#22c55e',method:'#16a34a',class:'#a855f7',
  constant:'#f59e0b',variable:'#eab308',interface:'#38bdf8',enum:'#38bdf8',enum_member:'#38bdf8',
  type_alias:'#38bdf8',prop:'#f472b6',doc:'#94a3b8',annotation:'#f87171'};
const EDGE_COLOR = {calls:'#22c55e',references:'#60a5fa',covers:'#f59e0b',mocks:'#f472b6',
  has_prop:'#a78bfa',imports:'#475569',contains:'#334155',documents:'#94a3b8',
  mirrors:'#f87171',divergent:'#ef4444'};
cytoscape.use(window.cytoscapeFcose);
const CHANGE_COLOR={added:'#22c55e',modified:'#f59e0b',deleted:'#ef4444'};
const LAYOUT={name:'fcose',quality:'proof',animate:false,randomize:true,
  nodeDimensionsIncludeLabels:true,uniformNodeDimensions:false,packComponents:true,
  nodeRepulsion:60000,idealEdgeLength:150,edgeElasticity:0.1,gravity:0.15,gravityRange:3.8,
  numIter:3000,tile:true,nodeSeparation:200,padding:60};
const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: [...DATA.nodes, ...DATA.edges],
  minZoom:0.15, maxZoom:3,
  style: [
    {selector:'node',style:{
      'background-color':ele=>KIND_COLOR[ele.data('kind')]||'#64748b',
      'label':'data(label)','color':'#cbd5e1','font-size':10,'text-wrap':'ellipsis',
      'text-max-width':140,'text-valign':'bottom','text-margin-y':4,
      'text-background-color':'#0f172a','text-background-opacity':0.72,'text-background-padding':2,
      'text-background-shape':'roundrectangle','min-zoomed-font-size':7,
      'width':ele=>ele.data('kind')==='file'?12:18,'height':ele=>ele.data('kind')==='file'?12:18,
      'shape':ele=>ele.data('kind')==='file'?'round-rectangle':'ellipse'}},
    {selector:'node[change="added"]',style:{'border-width':5,'border-color':CHANGE_COLOR.added,
      'width':26,'height':26,'font-size':13,'color':'#fff','z-index':10}},
    {selector:'node[change="modified"]',style:{'border-width':5,'border-color':CHANGE_COLOR.modified,
      'width':26,'height':26,'font-size':13,'color':'#fff','z-index':10}},
    {selector:'node[change="deleted"]',style:{'border-width':5,'border-color':CHANGE_COLOR.deleted,
      'border-style':'dashed','shape':'round-rectangle','width':24,'height':24,'font-size':13,'color':'#fff','z-index':10}},
    {selector:'edge',style:{'width':1.4,'line-color':ele=>EDGE_COLOR[ele.data('kind')]||'#475569',
      'target-arrow-color':ele=>EDGE_COLOR[ele.data('kind')]||'#475569','target-arrow-shape':'triangle',
      'curve-style':'bezier','arrow-scale':0.9,'opacity':0.6}},
    {selector:'.dim',style:{'opacity':0.07}},
    {selector:'.hl',style:{'opacity':1,'width':3}}
  ],
  layout: LAYOUT
});
function relayout(){cy.layout(LAYOUT).run();}

// summary
const chg=META.changes||{added:0,modified:0,deleted:0};
const modeLine = META.mode==='pr'
  ? 'PR vs <b>'+(META.base||'?')+'</b>'
  : (META.mode==='diff' ? 'working-tree diff' : 'seeded view');
document.getElementById('summary').innerHTML =
  modeLine+'<br><b>'+META.counts.nodes+'</b> nodes · <b>'+META.counts.edges+'</b> edges · hops '+META.hops+
  '<br><span style="color:'+'#22c55e'+'">+'+chg.added+' added</span> · '+
  '<span style="color:#f59e0b">~'+chg.modified+' modified</span> · '+
  '<span style="color:#ef4444">-'+chg.deleted+' deleted</span>'+
  ((META.changedFiles&&META.changedFiles.length)?
    '<h2>changed files</h2>'+META.changedFiles.map(f=>'<div class=kv><span class=pill style="border-color:'+
      ({added:'#22c55e',modified:'#f59e0b',deleted:'#ef4444'}[f.status]||'#475569')+'">'+f.status[0].toUpperCase()+'</span> '+
      (f.file.slice(0,4)==='src/'?f.file.slice(4):f.file)+'</div>').join(''):'');

// legend
const usedKinds=[...new Set(DATA.nodes.map(n=>n.data.kind))];
document.getElementById('legend').innerHTML =
  '<div style="margin-bottom:4px"><b style="color:#94a3b8;font-size:11px">change</b></div>'+
  '<div><span class="swatch" style="background:#0f172a;border:3px solid #22c55e"></span>added</div>'+
  '<div><span class="swatch" style="background:#0f172a;border:3px solid #f59e0b"></span>modified</div>'+
  '<div><span class="swatch" style="background:#0f172a;border:3px dashed #ef4444"></span>deleted</div>'+
  '<div style="margin:8px 0 4px"><b style="color:#94a3b8;font-size:11px">node kind</b></div>'+
  usedKinds.map(k=>'<div><span class="swatch" style="background:'+(KIND_COLOR[k]||'#64748b')+'"></span>'+k+'</div>').join('');

// edge filters
const kinds=[...new Set(DATA.edges.map(e=>e.data.kind))].sort();
document.getElementById('edgeFilters').innerHTML = kinds.map(k=>
  '<label class="chk"><input type="checkbox" class="ef" value="'+k+'" checked>'+
  '<span class="swatch" style="background:'+(EDGE_COLOR[k]||'#475569')+'"></span>'+k+'</label>').join('');
function applyEdgeFilter(){
  const on=new Set([...document.querySelectorAll('.ef:checked')].map(x=>x.value));
  const hideStruct=document.getElementById('hideStruct').checked;
  cy.edges().forEach(e=>{const k=e.data('kind');
    const show=on.has(k)&&!(hideStruct&&(k==='imports'||k==='contains'));
    e.style('display',show?'element':'none');});
}
document.querySelectorAll('.ef').forEach(x=>x.addEventListener('change',applyEdgeFilter));
document.getElementById('hideStruct').addEventListener('change',applyEdgeFilter);
applyEdgeFilter();

// search
document.getElementById('q').addEventListener('input',e=>{
  const v=e.target.value.toLowerCase();
  if(!v){cy.elements().removeClass('dim hl');return;}
  cy.elements().addClass('dim');
  const m=cy.nodes().filter(n=>(n.data('label')||'').toLowerCase().includes(v));
  m.removeClass('dim').addClass('hl'); m.neighborhood().removeClass('dim');
});

// detail pane
cy.on('tap','node',ev=>{
  const d=ev.target.data();
  document.getElementById('detail').innerHTML =
    '<div style="margin-bottom:6px"><span class=pill>'+d.kind+'</span> '+(d.change?'<span class=pill style="border-color:'+({added:'#22c55e',modified:'#f59e0b',deleted:'#ef4444'}[d.change]||'#ef4444')+';color:'+({added:'#22c55e',modified:'#f59e0b',deleted:'#ef4444'}[d.change]||'#ef4444')+'">'+d.change+'</span>':'')+'</div>'+
    '<b>'+d.label+'</b>'+
    (d.file?'<div class=kv style="margin:6px 0">'+d.file+(d.line?':'+d.line:'')+'</div>':'')+
    (d.sig?'<h2>signature</h2><pre>'+esc(d.sig)+'</pre>':'')+
    (d.doc?'<h2>doc</h2><pre>'+esc(d.doc)+'</pre>':'')+
    '<h2>neighbors</h2><div class=kv>'+ev.target.neighborhood('node').map(n=>n.data('label')).slice(0,20).join(', ')+'</div>';
  cy.elements().removeClass('dim hl'); cy.elements().addClass('dim');
  ev.target.closedNeighborhood().removeClass('dim').addClass('hl');
});
cy.on('tap',ev=>{if(ev.target===cy){cy.elements().removeClass('dim hl');}});
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
document.getElementById('fit').onclick=()=>cy.fit(null,40);
document.getElementById('relayout').onclick=relayout;
</script></body></html>`;

// ---------- emit HTML ----------
let tpl = TEMPLATE;
if (argv.includes("--inline")) {
  const libs = [
    "https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js",
    "https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.js",
    "https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.js",
    "https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.js",
  ];
  for (const u of libs) {
    let js = "";
    try { js = execFileSync("curl", ["-s", "--max-time", "20", u], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
    catch (_) { console.error("cg-graph: --inline could not fetch " + u + " (leaving CDN tag)"); continue; }
    const tag = `<script src="${u}"></` + "script>";
    tpl = tpl.replace(tag, () => "<script>\n" + js + "\n</" + "script>");
  }
  console.log("cg-graph: inlined libraries (self-contained output)");
}
const html = tpl
  .replace("/*__ELEMENTS__*/", () => JSON.stringify({ nodes: elNodes, edges: elEdges }))
  .replace("/*__META__*/", () => JSON.stringify(meta));
fs.writeFileSync(OUT, html);
console.log(`cg-graph: wrote ${OUT}`);
console.log(`  seeds: ${meta.seeds.join(", ")}`);
console.log(`  nodes: ${meta.counts.nodes}  edges: ${meta.counts.edges}  (hops=${HOPS})`);
console.log(`  edge kinds: ${meta.edgeKinds.join(", ")}`);

// ---------- self-verify (dependency-free): the page must actually be runnable ----------
if (argv.includes("--verify") || argv.includes("--verify-render")) {
  const os = require("os");
  const fail = msg => { console.error("cg-graph: VERIFY FAILED — " + msg); process.exit(2); };
  const written = fs.readFileSync(OUT, "utf8");
  // 1) the body <script> must be syntactically valid JS (catches template-literal escaping bugs)
  const blocks = [...written.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) fail("no <script> blocks in output");
  const body = blocks[blocks.length - 1];
  const tmp = path.join(os.tmpdir(), "cg-graph-verify-" + process.pid + ".js");
  fs.writeFileSync(tmp, body);
  try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
  catch (e) { fs.unlinkSync(tmp); fail("body script has a syntax error:\n" + (e.stderr || e.stdout || e.message).toString().split("\n").slice(0, 4).join("\n")); }
  fs.unlinkSync(tmp);
  // 2) the injected DATA/META must be valid JSON
  try { JSON.parse(written.match(/const DATA = (\{[\s\S]*?\});\nconst META/)[1]); }
  catch (_) { fail("embedded DATA is not valid JSON"); }
  try { JSON.parse(written.match(/const META = (\{[\s\S]*?\});/)[1]); }
  catch (_) { fail("embedded META is not valid JSON"); }
  console.log("cg-graph: verify OK (script parses, DATA/META valid)");
  // 3) optional real render check if Playwright is resolvable (--verify-render, or auto when present)
  const pwPath = arg("--playwright"); // optional path to a node_modules with @playwright/test
  if (argv.includes("--verify-render") || pwPath) {
    try {
      const req = pwPath ? require(path.join(pwPath, "node_modules/@playwright/test")) : require("@playwright/test");
      const script = `(async()=>{const {chromium}=require(${JSON.stringify(pwPath ? path.join(pwPath, "node_modules/@playwright/test") : "@playwright/test")});` +
        `const b=await chromium.launch({channel:'chrome'});const p=await b.newPage();const errs=[];` +
        `p.on('pageerror',e=>errs.push(e.message));await p.goto('file://'+${JSON.stringify(path.resolve(OUT))});` +
        `await p.waitForTimeout(2000);const n=await p.evaluate(()=>document.querySelectorAll('#cy canvas').length);` +
        `await b.close();if(!n||errs.length){console.error('render FAIL canvases='+n+' '+(errs[0]||''));process.exit(3);}` +
        `console.log('cg-graph: verify-render OK ('+n+' canvases)');})();`;
      void req;
      const rtmp = path.join(os.tmpdir(), "cg-graph-render-" + process.pid + ".cjs");
      fs.writeFileSync(rtmp, script);
      try { execFileSync(process.execPath, [rtmp], { stdio: "inherit" }); } finally { fs.unlinkSync(rtmp); }
    } catch (e) { console.error("cg-graph: verify-render skipped (Playwright not resolvable): " + e.message); }
  }
}
