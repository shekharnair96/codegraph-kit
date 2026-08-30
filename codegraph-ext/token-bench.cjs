#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/token-bench.cjs — quantify the context-token savings of cg:ask
 * versus the naive "grep, then read whole files" approach an agent falls back to
 * when it has no symbol graph.
 *
 * ZERO-CONFIG: it auto-discovers the highest-fan-in questions in whatever repo it
 * runs against (the most-mocked module, the most-covered source file, the widest
 * prop surface, a documented symbol), so it is drop-in for any microapp that has
 * the codegraph-ext overlay built. No hand-picked file paths.
 *
 * For each question we compute:
 *   naive  = a grep listing + the FULL text of every file you'd have to open to
 *            reconstruct the answer with certainty (the overlay tells us exactly
 *            which files those are; the cost charged is their real on-disk size).
 *   cg:ask = the exact stdout the overlay hands back for the same question.
 *
 * Token counts are chars/4 approximations (no tokenizer dependency — keeps this
 * portable). Absolute numbers are ±~20%; the RELATIVE reduction is the signal.
 *
 * Run:  node codegraph-ext/token-bench.cjs   (or: npm run cg:bench)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DB = path.join(ROOT, ".codegraph", "codegraph.db");
const QUERY = path.join(__dirname, "query.cjs");
const GREP_COST = 60; // fixed cost of a `ripgrep -l` candidate listing

const esc = s => String(s).replace(/'/g, "''");
const q = sql => {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
};
const one = sql => q(sql)[0] || {};
const toks = s => Math.ceil((s || "").length / 4);
const relOf = id => String(id).replace(/^file:/, "");
const readToks = rel => {
  try {
    return toks(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  } catch (_) {
    return 0;
  }
};
const ask = (cmd, arg) => {
  try {
    return execFileSync("node", [QUERY, cmd, arg], { encoding: "utf8" });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
};
const filesForEdge = (kind, argLike) =>
  q(
    `SELECT DISTINCT e.source s FROM edges e JOIN nodes n ON n.id=e.target ` +
      `WHERE e.kind='${kind}' AND e.provenance='ext' AND n.file_path LIKE '%${esc(argLike)}%';`
  ).map(r => relOf(r.s));
const filesForSymbol = name =>
  q(
    `SELECT DISTINCT file_path f FROM nodes WHERE name='${esc(name)}' ` +
      `AND file_path IS NOT NULL AND file_path NOT LIKE '%__tests__%';`
  )
    .map(r => r.f)
    .filter(Boolean);

// ---------- auto-discover the highest-value question of each kind ----------
function discover() {
  const cases = [];
  const mostMocked = one(
    `SELECT n.file_path f, count(DISTINCT e.source) c FROM edges e JOIN nodes n ON n.id=e.target ` +
      `WHERE e.kind='mocks' AND e.provenance='ext' AND n.file_path IS NOT NULL GROUP BY n.file_path ORDER BY c DESC LIMIT 1;`
  );
  if (mostMocked.f)
    cases.push({
      q: `Which tests mock ${mostMocked.f}? (+exports)`,
      cmd: "mocks",
      arg: mostMocked.f,
      files: () => filesForEdge("mocks", mostMocked.f),
    });

  const mostCovered = one(
    `SELECT n.file_path f, count(DISTINCT e.source) c FROM edges e JOIN nodes n ON n.id=e.target ` +
      `WHERE e.kind='covers' AND e.provenance='ext' AND n.file_path IS NOT NULL GROUP BY n.file_path ORDER BY c DESC LIMIT 1;`
  );
  if (mostCovered.f)
    cases.push({
      q: `Which tests cover ${mostCovered.f}?`,
      cmd: "covers",
      arg: mostCovered.f,
      files: () => filesForEdge("covers", mostCovered.f),
    });

  const widestProps = one(
    `SELECT c.name nm, count(*) c FROM edges e JOIN nodes c ON c.id=e.source JOIN nodes p ON p.id=e.target ` +
      `WHERE e.kind='has_prop' AND e.provenance='ext' GROUP BY c.name ORDER BY c DESC LIMIT 1;`
  );
  if (widestProps.nm)
    cases.push({
      q: `What props does ${widestProps.nm} accept?`,
      cmd: "props",
      arg: widestProps.nm,
      files: () => filesForSymbol(widestProps.nm),
    });

  const documented = one(
    `SELECT n.name nm FROM edges e JOIN nodes n ON n.id=e.target ` +
      `WHERE e.kind='documents' AND e.provenance='ext' AND n.name IS NOT NULL ORDER BY length(n.name) DESC LIMIT 1;`
  );
  if (documented.nm)
    cases.push({
      q: `Signature + doc for ${documented.nm}?`,
      cmd: "docs",
      arg: documented.nm,
      files: () => filesForSymbol(documented.nm),
    });

  return cases;
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const CASES = discover();
if (!CASES.length) {
  console.error("No ext overlay rows found — run `npm run cg:augment` first.");
  process.exit(1);
}

console.log("\ncodegraph-ext token bench — context tokens needed to ANSWER each question");
console.log("naive = grep listing + full text of every file you'd have to open");
console.log("cg:ask = the overlay's answer for the same question   (chars/4 estimate)\n");
console.log(
  pad("question (auto-discovered)", 56) +
    padL("files", 6) +
    padL("naive", 9) +
    padL("cg:ask", 9) +
    padL("saved", 9) +
    padL("cut", 6)
);
console.log("-".repeat(95));

let tB = 0;
let tO = 0;
for (const c of CASES) {
  const files = c.files();
  const baseline = GREP_COST + files.reduce((a, f) => a + readToks(f), 0);
  const optimized = toks(ask(c.cmd, c.arg));
  tB += baseline;
  tO += optimized;
  const pct = baseline ? Math.round((1 - optimized / baseline) * 100) : 0;
  console.log(
    pad(c.q.slice(0, 55), 56) +
      padL(files.length, 6) +
      padL(baseline, 9) +
      padL(optimized, 9) +
      padL(baseline - optimized, 9) +
      padL(pct + "%", 6)
  );
}
console.log("-".repeat(95));
const totalPct = tB ? Math.round((1 - tO / tB) * 100) : 0;
console.log(
  pad("TOTAL", 56) + padL("", 6) + padL(tB, 9) + padL(tO, 9) + padL(tB - tO, 9) + padL(totalPct + "%", 6)
);
console.log(
  `\nAcross ${CASES.length} auto-discovered questions: naive ≈ ${tB} tok vs cg:ask ≈ ${tO} tok → ${totalPct}% fewer context tokens.`
);
console.log(
  "(Counts context LOADED to answer; model output tokens are ~equal either way. chars/4 estimate.)\n"
);
