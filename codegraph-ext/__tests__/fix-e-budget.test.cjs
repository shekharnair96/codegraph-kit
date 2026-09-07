#!/usr/bin/env node
/* Fix E regression test: drives a REAL codegraph-mcp.cjs over stdio (newline-delimited JSON-RPC).
 *
 * Asserts the three behaviours Fix E is responsible for:
 *   1. GUARDRAIL INTACT  — a back-to-back runaway loop still hits CALL BUDGET EXHAUSTED.
 *   2. TASK BOUNDARY     — after an idle gap (CG_TASK_IDLE_MS), the budget resets, so a genuinely
 *                          new task is NOT punished for a previous task's usage. This is the bug
 *                          that mattered: discovery-only runs never armed the edit-based reset, so
 *                          the budget had degraded into a session-lifetime countdown.
 *   3. ROOT ISOLATION    — exhausting root A's budget must NOT block root B.
 *
 * Budgets are squeezed via env so the test is fast and doesn't depend on the real 60-call default.
 */
const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "..", "codegraph-mcp.cjs");
const ROOT_A = process.argv[2] || process.env.CG_TEST_ROOT;
if (!ROOT_A) {
  console.error("usage: node fix-e-budget.test.cjs <indexed-repo-root> [second-root]");
  process.exit(2);
}
const ROOT_B = process.argv[3] || null; // optional second root for the isolation case
const BUDGET = 4;
const IDLE_MS = 1200;

const srv = spawn("node", [SERVER], {
  env: { ...process.env, CG_CALL_BUDGET: String(BUDGET), CG_TASK_IDLE_MS: String(IDLE_MS), CG_LOCATE_BUDGET: "999" },
  stdio: ["pipe", "pipe", "pipe"],
});
srv.stderr.on("data", d => process.env.CG_TEST_VERBOSE && process.stderr.write(`[srv] ${d}`));
// Never let the harness exit silently on a dead/misbehaving server -- a silent pass is worse than a fail.
srv.on("exit", code => { if (code !== 0 && code !== null) { console.error(`FATAL: server exited early (code ${code}). Re-run with CG_TEST_VERBOSE=1.`); process.exit(1); } });
const withTimeout = (p, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), 30000))]);
process.on("unhandledRejection", e => { console.error(`FATAL: ${e.message}`); srv.kill(); process.exit(1); });

let nextId = 1;
const pending = new Map();
let outBuf = "";
srv.stdout.on("data", chunk => {
  outBuf += chunk;
  let i;
  while ((i = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, i);
    outBuf = outBuf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    const res = pending.get(msg.id);
    if (res) { pending.delete(msg.id); res(msg); }
  }
});

const rpcRaw = (method, params) => new Promise(res => {
  const id = nextId++;
  pending.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const rpc = (method, params) => withTimeout(rpcRaw(method, params), method);
const textOf = m => (((m.result || {}).content || [])[0] || {}).text || "";
const isExhausted = m => /CALL BUDGET EXHAUSTED/.test(textOf(m));
const locate = root => rpc("tools/call", { name: "codegraph_locate", arguments: { query: "series color", projectRoot: root } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (label, pass, detail) => { results.push({ label, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`); };

(async () => {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixE-test", version: "1" } });

  // ---- 1. guardrail intact: a tight loop must still be cut off ----
  let hitAt = null;
  for (let i = 1; i <= BUDGET + 3; i++) {
    const r = await locate(ROOT_A);
    if (isExhausted(r) && hitAt === null) hitAt = i;
  }
  check("1. runaway loop still hits the budget wall", hitAt !== null, hitAt ? `first blocked at call ${hitAt} (budget ${BUDGET})` : "never blocked -- guardrail lost");

  // ---- 2. task boundary: idle gap resets the budget for a NEW task ----
  const blockedBefore = isExhausted(await locate(ROOT_A));
  await sleep(IDLE_MS + 400);
  const afterIdle = await locate(ROOT_A);
  check("2. idle gap resets budget (new task not punished)", blockedBefore && !isExhausted(afterIdle),
        `blocked before idle=${blockedBefore}, blocked after idle=${isExhausted(afterIdle)}`);

  // ---- 3. root isolation: exhausting A must not block B ----
  if (ROOT_B) {
    for (let i = 0; i < BUDGET + 2; i++) await locate(ROOT_A);
    const aBlocked = isExhausted(await locate(ROOT_A));
    const bResp = await locate(ROOT_B);
    check("3. exhausted root A does not block root B", aBlocked && !isExhausted(bResp),
          `A blocked=${aBlocked}, B blocked=${isExhausted(bResp)}`);
  } else {
    console.log("SKIP  3. root isolation (no second root passed)");
  }

  srv.kill();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed`);
  process.exit(failed ? 1 : 0);
})();
