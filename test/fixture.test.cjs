/* End-to-end test: index the fixture project, build the overlays, and assert both the
 * graph shape (via the sqlite3 CLI) and the user-facing query.cjs output. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const KIT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixture");
const CG_BIN = path.join(KIT, "codegraph-ext", "engine", "bin", "codegraph.js");

const run = (args, opts = {}) =>
  spawnSync("node", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });

// Query the graph DB through the sqlite3 CLI (the same way the kit's scripts do).
function sql(db, statement) {
  const r = spawnSync("sqlite3", ["-json", db, statement], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `sqlite3 failed: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

test("fixture indexes, augments and answers locate/trace/plan", { timeout: 120000 }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-kit-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 1. fresh copy of the fixture
  fs.cpSync(FIXTURE, tmp, { recursive: true });

  // 2. index it
  const init = run([CG_BIN, "init", tmp, "-i"]);
  assert.strictEqual(init.status, 0, `init failed:\n${init.stdout}\n${init.stderr}`);

  // 3. drop the kit's scripts + starter annotations in, then build the overlays
  const extDir = path.join(tmp, "codegraph-ext");
  fs.mkdirSync(extDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(KIT, "codegraph-ext"))) {
    if (f.endsWith(".cjs")) fs.copyFileSync(path.join(KIT, "codegraph-ext", f), path.join(extDir, f));
  }
  fs.copyFileSync(path.join(KIT, "codegraph-ext", "annotations.json"), path.join(extDir, "annotations.json"));

  const aug = run([path.join(extDir, "augment.cjs")], { cwd: tmp });
  assert.strictEqual(aug.status, 0, `augment failed:\n${aug.stdout}\n${aug.stderr}`);
  const body = run([path.join(extDir, "build-body-index.cjs")], { cwd: tmp });
  assert.strictEqual(body.status, 0, `build-body-index failed:\n${body.stdout}\n${body.stderr}`);

  // ---- graph shape ----
  const db = path.join(tmp, ".codegraph", "codegraph.db");
  assert.ok(fs.existsSync(db), "codegraph.db was not created");

  const color = sql(
    db,
    "SELECT kind, file_path, start_line, is_exported FROM nodes WHERE name='PRIMARY_SERIES_COLOR'"
  );
  assert.strictEqual(color.length, 1, "expected exactly one PRIMARY_SERIES_COLOR node");
  assert.strictEqual(color[0].kind, "constant");
  assert.strictEqual(color[0].file_path, "src/config/colors.ts");
  assert.strictEqual(color[0].start_line, 2);
  assert.strictEqual(color[0].is_exported, 1);

  const calls = sql(
    db,
    `SELECT 1 FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
      WHERE e.kind='calls' AND s.name='buildCompareSeries' AND t.name='buildSeries'`
  );
  assert.ok(calls.length >= 1, "missing calls edge buildCompareSeries -> buildSeries");

  const ext = sql(
    db,
    `SELECT 1 FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
      WHERE e.kind='extends' AND s.name='NamedRegistry' AND t.name='SeriesRegistry'`
  );
  assert.ok(ext.length >= 1, "missing extends edge NamedRegistry -> SeriesRegistry");

  const covers = sql(
    db,
    `SELECT s.file_path AS src FROM edges e
       JOIN nodes s ON s.id = e.source
      WHERE e.kind='covers' AND e.provenance='ext' AND e.target='file:src/utils/series.ts'`
  );
  assert.ok(
    covers.some((r) => String(r.src).includes("RevenueChart.test.tsx")),
    `missing 'ext' covers edge from the test file to file:src/utils/series.ts (got ${JSON.stringify(covers)})`
  );

  const legacy = sql(
    db,
    "SELECT file_path, is_exported FROM nodes WHERE name='legacyBuild'"
  );
  assert.ok(legacy.length >= 1, "legacyBuild node missing");
  const legacyRow = legacy.find((r) => r.file_path === "src/utils/legacy.js");
  assert.ok(legacyRow, "legacyBuild not found in src/utils/legacy.js");
  assert.strictEqual(legacyRow.is_exported, 1, "CommonJS export heuristic did not mark legacyBuild exported");

  // ---- user-facing query output ----
  const QUERY = path.join(extDir, "query.cjs");

  const locate = run([QUERY, "locate", "primary series color"], { cwd: tmp });
  assert.strictEqual(locate.status, 0, `locate failed:\n${locate.stdout}\n${locate.stderr}`);
  assert.match(locate.stdout, /STRONG MATCH: PRIMARY_SERIES_COLOR/);

  // The experiment harness's Python candidate generator parses locate output with this regex;
  // keep the printed candidate lines compatible with it.
  const HARNESS_RE = /^ {2}([A-Za-z_$][\w$]*)\s+\[([^\]]+)\]\s+(\S+?):(\d+)/m;
  assert.match(locate.stdout, HARNESS_RE, "no locate candidate line matched the harness regex");

  const trace = run([QUERY, "trace", "RevenueChart", "--concept", "color"], { cwd: tmp });
  assert.strictEqual(trace.status, 0, `trace failed:\n${trace.stdout}\n${trace.stderr}`);
  assert.match(trace.stdout, /METRIC_SERIES_COLORS/);

  const plan = run([QUERY, "plan", "buildSeries", "set strokeWidth to 3"], { cwd: tmp });
  assert.strictEqual(plan.status, 0, `plan failed:\n${plan.stdout}\n${plan.stderr}`);
  assert.match(plan.stdout, /src\/utils\/series\.ts:18/);
  assert.match(plan.stdout, /src\/config\/index\.ts:2/);

  // ---- the MCP server's budget/isolation regression test, against this indexed repo ----
  const fixE = run([path.join(KIT, "codegraph-ext", "__tests__", "fix-e-budget.test.cjs"), tmp]);
  assert.strictEqual(fixE.status, 0, `fix-e-budget failed:\n${fixE.stdout}\n${fixE.stderr}`);
});
