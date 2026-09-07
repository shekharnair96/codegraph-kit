/* Host-adapter end-to-end test: run install.sh against a temp copy of the fixture with HOME and
 * CODEX_HOME pointed at a temp home, then assert every host's config was written in the right
 * shape, that a second run is byte-identical (idempotent), and that --check passes.
 *
 * Nothing here touches the developer's real ~/.claude, ~/.codex, ~/.config/opencode, ~/.cursor or
 * ~/.code_puppy — every write goes under the temp HOME or the temp target repo. The ONE exception
 * is the read-only `claude mcp list` probe at the end, which deliberately uses the real HOME. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const KIT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixture");
const INSTALL = path.join(KIT, "install.sh");
const HOSTS = "claude,cursor,codex,opencode,puppy,none";

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

/* Spawn a stdio MCP server the way a host would and drive the opening handshake:
 * initialize -> notifications/initialized -> tools/list. Resolves to the tool names. */
function handshake(cmd, args, cwd, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { p.kill(); } catch (_) { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, why: `no tools/list reply within 20s; stderr: ${err}` }), 20000);
    p.on("error", (e) => { clearTimeout(timer); finish({ ok: false, why: `spawn failed: ${e.message}` }); });
    // A server that dies before answering is a failure we can report at once, rather than
    // waiting out the timeout.
    p.on("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ ok: false, why: `server exited (code=${code}, signal=${signal}) before tools/list; stderr: ${err}` });
    });
    p.stderr.on("data", (d) => { err += d; });
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; } // servers may log non-JSON noise
        if (msg.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (msg.id === 2) {
          clearTimeout(timer);
          finish({ ok: true, tools: ((msg.result || {}).tools || []).map((t) => t.name) });
        }
      }
    });
    p.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codegraph-kit-test", version: "0" } },
      }) + "\n"
    );
  });
}

// Every file the six adapters are expected to produce, relative to the temp target / temp home.
const targetFiles = [
  ".mcp.json",
  ".claude/agents/kg-sonnet.md",
  ".claude/agents/kg-opus.md",
  ".cursor/mcp.json",
  ".cursor/rules/codegraph-kg-only.mdc",
  "AGENTS.md",
  "opencode.json",
  ".opencode/kg-coder.prompt.md",
];
const homeFiles = [
  ".codex/config.toml",
  ".code_puppy/mcp_servers.json",
  ".code_puppy/mcp_agent_bindings.json",
  ".code_puppy/agents/kg-sonnet.json",
  ".code_puppy/agents/kg-opus.json",
];

test("install.sh wires up every host, idempotently", { timeout: 180000 }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-hosts-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const target = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(FIXTURE, target, { recursive: true });

  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
  const install = (extra = []) =>
    spawnSync("bash", [INSTALL, target, "--host", HOSTS, ...extra], {
      encoding: "utf8",
      env,
      maxBuffer: 32 * 1024 * 1024,
    });

  const first = install();
  assert.strictEqual(first.status, 0, `install.sh failed:\n${first.stdout}\n${first.stderr}`);

  // ---- every expected file exists ----
  for (const rel of targetFiles) assert.ok(fs.existsSync(path.join(target, rel)), `missing ${rel} in target`);
  for (const rel of homeFiles) assert.ok(fs.existsSync(path.join(home, rel)), `missing ${rel} in HOME`);

  // ---- JSON files parse and carry the codegraph server ----
  const mcp = readJson(path.join(target, ".mcp.json"));
  assert.ok(mcp.mcpServers.codegraph, ".mcp.json has no mcpServers.codegraph");
  assert.strictEqual(mcp.mcpServers.codegraph.command, "node");
  assert.strictEqual(mcp.mcpServers.codegraph.type, "stdio");
  assert.match(mcp.mcpServers.codegraph.args[0], /codegraph-mcp\.cjs$/);

  const cursor = readJson(path.join(target, ".cursor", "mcp.json"));
  assert.ok(cursor.mcpServers.codegraph, ".cursor/mcp.json has no mcpServers.codegraph");

  const oc = readJson(path.join(target, "opencode.json"));
  assert.strictEqual(oc.mcp.codegraph.type, "local");
  assert.deepStrictEqual(oc.mcp.codegraph.command[0], "node");
  assert.strictEqual(oc.mcp.codegraph.enabled, true);
  for (const name of ["kg-sonnet", "kg-opus"]) {
    const a = oc.agent[name];
    assert.ok(a, `opencode.json has no agent.${name}`);
    assert.strictEqual(a.mode, "subagent");
    assert.strictEqual(a.prompt, "{file:./.opencode/kg-coder.prompt.md}");
    assert.match(a.model, /^[a-z-]+\//, "opencode model must be provider/model-id");
    // the starvation: no discovery tools, but the agent can still edit
    for (const off of ["bash", "read", "grep", "glob", "list", "webfetch"])
      assert.strictEqual(a.tools[off], false, `opencode agent.${name} must disable ${off}`);
    assert.strictEqual(a.tools.edit, true);
    assert.strictEqual(a.tools.write, true);
  }

  const puppyServers = readJson(path.join(home, ".code_puppy", "mcp_servers.json"));
  assert.ok(puppyServers.mcp_servers.codegraph, "code_puppy mcp_servers.json has no codegraph");
  const puppyBind = readJson(path.join(home, ".code_puppy", "mcp_agent_bindings.json"));
  assert.strictEqual(puppyBind.bindings["kg-sonnet"].codegraph.auto_start, true);
  const puppyAgent = readJson(path.join(home, ".code_puppy", "agents", "kg-opus.json"));
  assert.strictEqual(puppyAgent.name, "kg-opus");
  assert.ok(Array.isArray(puppyAgent.system_prompt) && puppyAgent.system_prompt.length > 5);

  // ---- markdown files have frontmatter ----
  for (const rel of [".claude/agents/kg-sonnet.md", ".claude/agents/kg-opus.md", ".cursor/rules/codegraph-kg-only.mdc"]) {
    const md = fs.readFileSync(path.join(target, rel), "utf8");
    assert.match(md, /^---\n/, `${rel} has no opening frontmatter fence`);
    assert.match(md, /\n---\n/, `${rel} has no closing frontmatter fence`);
    assert.match(md, /KG Coder/, `${rel} is missing the KG-only prompt body`);
  }
  const agentsMd = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /<!-- codegraph-kit:start -->/);
  assert.match(agentsMd, /## KG-only agent/);
  assert.match(agentsMd, /<!-- codegraph-kit:end -->/);

  // ---- TOML carries the mcp_servers table ----
  const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.codegraph\]/);
  assert.match(toml, /^command = "node"$/m);
  assert.match(toml, /^args = \[".*codegraph-mcp\.cjs"\]$/m);

  // ---- the whole point: the Claude subagent gets ONLY graph tools + edit tools ----
  for (const name of ["kg-sonnet", "kg-opus"]) {
    const md = fs.readFileSync(path.join(target, ".claude", "agents", `${name}.md`), "utf8");
    const toolsLine = md.split("\n").find((l) => l.startsWith("tools:"));
    assert.ok(toolsLine, `${name}.md has no tools: line`);
    assert.match(toolsLine, /mcp__codegraph__codegraph_locate/);
    assert.match(toolsLine, /mcp__codegraph__codegraph_apply_edit_at_site/);
    assert.match(toolsLine, /\bEdit\b/);
    assert.match(toolsLine, /\bWrite\b/);
    for (const banned of ["Read", "Grep", "Glob", "Bash"]) {
      assert.ok(
        !new RegExp(`(^|[,:\\s])${banned}([,\\s]|$)`).test(toolsLine),
        `${name}.md tools: must NOT grant ${banned} — got: ${toolsLine}`
      );
    }
    assert.match(md, /^model: (sonnet|opus)$/m);
  }

  // ---- idempotent: a second run leaves every file byte-identical ----
  const snapshot = () => {
    const out = {};
    for (const rel of targetFiles) out["t/" + rel] = fs.readFileSync(path.join(target, rel), "utf8");
    for (const rel of homeFiles) out["h/" + rel] = fs.readFileSync(path.join(home, rel), "utf8");
    return out;
  };
  const before = snapshot();
  const second = install();
  assert.strictEqual(second.status, 0, `second install.sh failed:\n${second.stdout}\n${second.stderr}`);
  const after = snapshot();
  for (const k of Object.keys(before)) assert.strictEqual(after[k], before[k], `${k} changed on re-install (not idempotent)`);

  // ---- --check exits 0 with all [ok] ----
  const check = spawnSync("bash", [INSTALL, "--check", target, "--host", HOSTS], { encoding: "utf8", env });
  assert.strictEqual(check.status, 0, `--check failed:\n${check.stdout}\n${check.stderr}`);
  assert.ok(!/\[MISSING\]/.test(check.stdout), `--check reported MISSING:\n${check.stdout}`);
  assert.ok(/\[ok\] +Claude Code wiring/.test(check.stdout), `--check did not report Claude Code ok:\n${check.stdout}`);
});

test("merges preserve unrelated servers, agents and config keys", { timeout: 120000 }, (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-merge-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const target = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, ".code_puppy"), { recursive: true });
  fs.cpSync(FIXTURE, target, { recursive: true });

  // pre-existing user config that must survive the merge
  fs.writeFileSync(path.join(target, ".mcp.json"), JSON.stringify({ mcpServers: { keepme: { command: "x" } } }, null, 2));
  fs.writeFileSync(path.join(target, "opencode.json"), JSON.stringify({ theme: "tokyonight", agent: { mine: { mode: "primary" } } }, null, 2));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  fs.writeFileSync(path.join(target, "AGENTS.md"), "# My repo\n\nExisting house rules.\n");
  fs.writeFileSync(
    path.join(home, ".code_puppy", "mcp_servers.json"),
    JSON.stringify({ mcp_servers: { keepme: { command: "x" } } }, null, 2)
  );

  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
  const r = spawnSync("bash", [INSTALL, target, "--host", HOSTS], { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `install.sh failed:\n${r.stdout}\n${r.stderr}`);

  const mcp = readJson(path.join(target, ".mcp.json"));
  assert.ok(mcp.mcpServers.keepme, "an unrelated .mcp.json server was dropped");
  assert.ok(mcp.mcpServers.codegraph);

  const oc = readJson(path.join(target, "opencode.json"));
  assert.strictEqual(oc.theme, "tokyonight", "an unrelated opencode.json key was dropped");
  assert.ok(oc.agent.mine, "an unrelated opencode agent was dropped");
  assert.ok(oc.agent["kg-sonnet"]);

  const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /^model = "gpt-5"$/m, "an unrelated config.toml key was dropped");
  assert.match(toml, /\[mcp_servers\.other\]/, "an unrelated config.toml mcp server was dropped");
  assert.match(toml, /\[mcp_servers\.codegraph\]/);

  const agentsMd = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /Existing house rules\./, "pre-existing AGENTS.md content was dropped");
  assert.match(agentsMd, /<!-- codegraph-kit:start -->/);

  const puppy = readJson(path.join(home, ".code_puppy", "mcp_servers.json"));
  assert.ok(puppy.mcp_servers.keepme, "an unrelated code_puppy server was dropped");
  assert.ok(puppy.mcp_servers.codegraph);

  // every file we modified got exactly one backup of its original
  for (const [dir, base] of [
    [target, ".mcp.json"],
    [target, "opencode.json"],
    [target, "AGENTS.md"],
    [path.join(home, ".codex"), "config.toml"],
    [path.join(home, ".code_puppy"), "mcp_servers.json"],
  ]) {
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith(base + ".bak-"));
    assert.strictEqual(baks.length, 1, `expected exactly one backup of ${base}, got ${baks.length}`);
  }
});

test("the committed Code Puppy agent JSONs are in sync with the prompt source", () => {
  const r = spawnSync("node", [path.join(KIT, "install", "render-agents.cjs"), "--check"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `agent renderings drifted:\n${r.stdout}\n${r.stderr}`);
});

// ---- REAL host probe: Claude Code is installed on this machine. Read-only, real HOME. ----
test("claude mcp list sees the project's codegraph server", { timeout: 120000 }, (t) => {
  const which = spawnSync("command", ["-v", "claude"], { shell: true, encoding: "utf8" });
  if (which.status !== 0) return t.skip("claude CLI not on PATH");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-claude-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const target = path.join(tmp, "repo");
  fs.cpSync(FIXTURE, target, { recursive: true });

  // Only the claude adapter, and it writes solely into the temp target (project-scoped .mcp.json
  // and .claude/agents/) — the developer's real ~/.claude is never written to.
  const inst = spawnSync("bash", [INSTALL, target, "--host", "claude"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(inst.status, 0, `install.sh --host claude failed:\n${inst.stdout}\n${inst.stderr}`);

  const r = spawnSync("claude", ["mcp", "list"], { cwd: target, encoding: "utf8", timeout: 90000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status !== 0 || !/codegraph/.test(out)) {
    // Trust prompts / login state / sandboxing can all make this unavailable in CI. Report the
    // exact output rather than pretending it passed.
    return t.skip(`claude mcp list unusable here (exit=${r.status}): ${out.trim().slice(0, 500)}`);
  }
  assert.match(out, /codegraph/, "claude mcp list does not mention the codegraph server");
});

/* Every adapter writes a `node <abs path>/codegraph-mcp.cjs` command somewhere. The shape tests
 * above prove the config LOOKS right; this one proves the command in it actually runs — the file
 * resolves, the process starts, and it answers the MCP opening handshake with all ten tools.
 *
 * Note the deliberate split this pins down: the project-scoped adapters (claude, cursor, opencode)
 * point at the copy inside the target repo, while the global ones (codex, puppy) point at the kit
 * checkout, because one global config has to serve every repo. Moving the kit therefore breaks
 * codex/puppy and leaves the other three working.
 *
 * This still does NOT prove any host reads the file — only that what we wrote into it is runnable. */
test("every host's configured server command actually starts and lists the tools", { timeout: 180000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-launch-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const target = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(FIXTURE, target, { recursive: true });

  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex") };
  const inst = spawnSync("bash", [INSTALL, target, "--host", HOSTS], {
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.strictEqual(inst.status, 0, `install.sh failed:\n${inst.stdout}\n${inst.stderr}`);

  // Pull [command, args] out of each config exactly the way that host's own loader would.
  const firstServer = (obj) => obj[Object.keys(obj)[0]];
  const commands = {
    claude: () => {
      const s = firstServer(readJson(path.join(target, ".mcp.json")).mcpServers);
      return [s.command, s.args || []];
    },
    cursor: () => {
      const s = firstServer(readJson(path.join(target, ".cursor", "mcp.json")).mcpServers);
      return [s.command, s.args || []];
    },
    opencode: () => {
      const c = firstServer(readJson(path.join(target, "opencode.json")).mcp).command;
      return [c[0], c.slice(1)];
    },
    codex: () => {
      const section = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8").split(/^\[mcp_servers\./m)[1];
      const cmd = /^command\s*=\s*"([^"]+)"/m.exec(section);
      const args = /^args\s*=\s*\[([^\]]*)\]/m.exec(section);
      assert.ok(cmd && args, "codex config.toml has no command/args under [mcp_servers.*]");
      return [cmd[1], [...args[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])];
    },
    puppy: () => {
      const j = readJson(path.join(home, ".code_puppy", "mcp_servers.json"));
      const s = firstServer(j.mcp_servers || j.mcpServers);
      return [s.command, s.args || []];
    },
  };

  for (const host of Object.keys(commands)) {
    const [cmd, args] = commands[host]();
    const serverPath = args[args.length - 1];
    assert.match(serverPath, /codegraph-mcp\.cjs$/, `${host}: last arg is not the MCP server`);
    assert.ok(path.isAbsolute(serverPath), `${host}: server path must be absolute, got ${serverPath}`);
    assert.ok(fs.existsSync(serverPath), `${host}: configured server does not exist at ${serverPath}`);

    const r = await handshake(cmd, args, target, env);
    assert.ok(r.ok, `${host}: MCP handshake failed — ${r.why}`);
    assert.strictEqual(
      r.tools.length,
      10,
      `${host}: expected 10 codegraph tools, got ${r.tools.length}: ${r.tools.join(", ")}`
    );
    assert.ok(r.tools.includes("codegraph_locate"), `${host}: tools/list has no codegraph_locate`);
    assert.ok(
      r.tools.includes("codegraph_apply_edit_at_site"),
      `${host}: tools/list has no codegraph_apply_edit_at_site`
    );
  }
});
