/* Call-budget test: drives a REAL codegraph-mcp.cjs over stdio (newline-delimited JSON-RPC)
 * against indexed copies of the fixture.
 *
 * The three behaviours the per-task budget is responsible for:
 *   1. GUARDRAIL INTACT  — a back-to-back runaway loop still hits CALL BUDGET EXHAUSTED.
 *   2. TASK BOUNDARY     — after an idle gap (CG_TASK_IDLE_MS), the budget resets, so a genuinely
 *                          new task is NOT punished for a previous task's usage. This is the bug
 *                          that mattered: discovery-only runs never armed the edit-based reset, so
 *                          the budget had degraded into a session-lifetime countdown.
 *   3. ROOT ISOLATION    — exhausting root A's budget must NOT block root B.
 *
 * Budgets are squeezed via env so the run is fast and doesn't depend on the real 60-call default.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const KIT = path.join(__dirname, "..");
const FIXTURE = path.join(KIT, "test-fixture");
const CG_BIN = path.join(KIT, "codegraph-ext", "engine", "bin", "codegraph.js");
const SERVER = path.join(KIT, "codegraph-ext", "codegraph-mcp.cjs");

const BUDGET = 4;
const IDLE_MS = 1200;

// A throwaway repo that looks like a real target: indexed graph + the codegraph-ext/ scripts the
// server shells out to. Same shape as test/fixture.test.cjs, minus the overlays — locate reads the
// base index, so augment/build-body-index would only add runtime here.
function indexedCopy(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-budget-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, tmp, { recursive: true });

  const init = spawnSync("node", [CG_BIN, "init", tmp, "-i"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(init.status, 0, `init failed:\n${init.stdout}\n${init.stderr}`);

  const extDir = path.join(tmp, "codegraph-ext");
  fs.mkdirSync(extDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(KIT, "codegraph-ext"))) {
    if (f.endsWith(".cjs")) fs.copyFileSync(path.join(KIT, "codegraph-ext", f), path.join(extDir, f));
  }
  fs.copyFileSync(path.join(KIT, "codegraph-ext", "annotations.json"), path.join(extDir, "annotations.json"));
  return tmp;
}

// Minimal JSON-RPC client over the server's stdio. Every request is timed out: a wedged server
// must fail the test rather than hang the suite.
function startServer(t) {
  const srv = spawn("node", [SERVER], {
    env: { ...process.env, CG_CALL_BUDGET: String(BUDGET), CG_TASK_IDLE_MS: String(IDLE_MS), CG_LOCATE_BUDGET: "999" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => srv.kill());

  let stderr = "";
  srv.stderr.on("data", d => { stderr += d; });

  const pending = new Map();
  let nextId = 1;
  let buf = "";
  srv.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  let exited = null;
  srv.on("exit", code => {
    exited = code;
    for (const [, resolve] of pending) resolve({ __dead: true });
    pending.clear();
  });

  const rpc = (method, params) => {
    const id = nextId++;
    const sent = new Promise(resolve => {
      pending.set(id, resolve);
      srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000).unref()
    );
    return Promise.race([sent, timeout]).then(msg => {
      assert.ok(!msg.__dead, `server exited early (code ${exited}) during ${method}:\n${stderr}`);
      return msg;
    });
  };
  return { rpc };
}

const textOf = m => (((m.result || {}).content || [])[0] || {}).text || "";
const isExhausted = m => /CALL BUDGET EXHAUSTED/.test(textOf(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("the per-task call budget cuts off runaways, resets on a task boundary, and is per-root", { timeout: 300000 }, async (t) => {
  const rootA = indexedCopy(t);
  const rootB = indexedCopy(t);
  const { rpc } = startServer(t);
  const locate = root => rpc("tools/call", { name: "codegraph_locate", arguments: { query: "series color", projectRoot: root } });

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "budget-test", version: "1" },
  });

  // ---- 1. guardrail intact: a tight loop must still be cut off ----
  let hitAt = null;
  for (let i = 1; i <= BUDGET + 3; i++) {
    if (isExhausted(await locate(rootA)) && hitAt === null) hitAt = i;
  }
  assert.ok(hitAt !== null, `runaway loop was never blocked — the guardrail is gone (budget ${BUDGET})`);

  // ---- 2. task boundary: an idle gap resets the budget for a NEW task ----
  assert.ok(isExhausted(await locate(rootA)), "expected root A to still be blocked before the idle gap");
  await sleep(IDLE_MS + 400);
  assert.ok(
    !isExhausted(await locate(rootA)),
    "budget did not reset after the idle gap — a new task is being punished for the previous one's usage"
  );

  // ---- 3. root isolation: exhausting A must not block B ----
  for (let i = 0; i < BUDGET + 2; i++) await locate(rootA);
  assert.ok(isExhausted(await locate(rootA)), "expected root A to be exhausted again");
  assert.ok(!isExhausted(await locate(rootB)), "root B was blocked by root A's exhausted budget — the budget is not per-root");
});
