#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * install/hosts.cjs — host-agnostic wiring for the codegraph MCP server + the KG-only agents.
 *
 * The kit itself is host-neutral: codegraph-ext/codegraph-mcp.cjs is a plain stdio JSON-RPC MCP
 * server that resolves the target repo from its cwd. What differs per host is (a) WHERE the server
 * registration goes and (b) whether the host can express a TOOL-RESTRICTED agent — which is the
 * whole thesis of this kit: starve the agent of grep/read/shell so it has to use the graph.
 *
 * Adapters:
 *   claude    project .mcp.json           + .claude/agents/*.md subagents  (TOOL-RESTRICTED)
 *   opencode  opencode.json mcp+agent     + .opencode/kg-coder.prompt.md   (TOOL-RESTRICTED)
 *   puppy     ~/.code_puppy/*.json        + ~/.code_puppy/agents/*.json    (TOOL-RESTRICTED)
 *   cursor    .cursor/mcp.json            + .cursor/rules/*.mdc            (rules only, no restriction)
 *   codex     $CODEX_HOME/config.toml     + AGENTS.md section              (no restriction)
 *   none      print a generic snippet
 *
 * Config shapes verified against vendor docs — see install/README.md for the URLs.
 * Plain CJS, zero dependencies. All merges preserve unrelated keys and are idempotent.
 *
 * CLI:
 *   node install/hosts.cjs detect  --target <abs> [--kit <abs>]
 *   node install/hosts.cjs install --host <name>[,<name>...] --target <abs> [--kit <abs>]
 *   node install/hosts.cjs check   --host <name>[,<name>...] --target <abs> [--kit <abs>]
 *   node install/hosts.cjs print   --target <abs> [--kit <abs>]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const KIT_DEFAULT = path.resolve(__dirname, "..");
const HOST_NAMES = ["claude", "cursor", "codex", "opencode", "puppy", "none"];

// ---------------------------------------------------------------- small utils

const log = (m) => console.log(m);
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  const raw = readIfExists(file);
  if (raw === null || raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt config must not silently lose the user's other servers/agents; we back it up
    // (writeOut does that) and start from the fallback rather than crashing the install.
    return fallback;
  }
}

/**
 * Write `content` to `file`, idempotently:
 *  - identical content -> no write at all (so re-running yields a byte-identical tree and makes
 *    no new backups).
 *  - existing but different -> back it up ONCE (the first time we ever touch it), then write.
 */
function writeOut(file, content) {
  const prev = readIfExists(file);
  if (prev === content) return { changed: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (prev !== null) {
    const dir = path.dirname(file);
    const base = path.basename(file) + ".bak-";
    const already = fs.readdirSync(dir).some((f) => f.startsWith(base));
    if (!already) fs.writeFileSync(path.join(dir, base + ts()), prev);
  }
  fs.writeFileSync(file, content);
  return { changed: true, file };
}

const writeJson = (file, obj) => writeOut(file, JSON.stringify(obj, null, 2) + "\n");

function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [bin] : ["-v", bin], {
    shell: process.platform !== "win32",
    encoding: "utf8",
  });
  return r.status === 0 && String(r.stdout || "").trim() !== "";
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- kit sources

function kitSources(kitDir) {
  const agentsDir = path.join(kitDir, "agents");
  const manifest = JSON.parse(fs.readFileSync(path.join(agentsDir, "manifest.json"), "utf8"));
  const prompt = fs
    .readFileSync(path.join(agentsDir, manifest.prompt || "kg-coder.prompt.md"), "utf8")
    .replace(/\s+$/, "");
  return { manifest, prompt, agentsDir };
}

/**
 * Ask the MCP server itself what tools it advertises, over its real transport (newline-delimited
 * JSON-RPC on stdio): initialize -> tools/list. We never hard-code the tool list — a tool added to
 * codegraph-mcp.cjs must show up in the Claude Code subagent allowlist without editing this file.
 */
function probeServerTools(serverPath) {
  const req =
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codegraph-installer", version: "1" } } }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
    "\n";
  const r = spawnSync(process.execPath, [serverPath], {
    input: req,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = String(r.stdout || "");
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      continue;
    }
    if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
      return msg.result.tools.map((t) => t.name).filter(Boolean);
    }
  }
  throw new Error(
    `could not probe MCP tools from ${serverPath} (exit=${r.status}, stderr=${String(r.stderr || "").slice(0, 400)})`
  );
}

// ---------------------------------------------------------------- context

function makeCtx(opts = {}) {
  const kitDir = path.resolve(opts.kitDir || KIT_DEFAULT);
  const targetDir = path.resolve(opts.targetDir || process.cwd());
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  // Project-scoped configs (.mcp.json, .cursor/mcp.json, opencode.json) point at the copy INSIDE
  // the repo, so the config travels with the checkout. GLOBAL configs (~/.code_puppy, Codex's
  // config.toml) are registered once for every repo, so they point at the kit's shared copy — the
  // server resolves the actual repo from its cwd either way.
  const serverPath = path.resolve(opts.serverPath || path.join(targetDir, "codegraph-ext", "codegraph-mcp.cjs"));
  const globalServerPath = path.resolve(opts.serverPath || path.join(kitDir, "codegraph-ext", "codegraph-mcp.cjs"));
  const env = opts.env || process.env;
  // Codex honours $CODEX_HOME; everything else keys off $HOME / $XDG_CONFIG_HOME.
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, ".codex"));
  const xdgConfig = path.resolve(env.XDG_CONFIG_HOME || path.join(home, ".config"));
  return { ...kitSources(kitDir), kitDir, targetDir, home, serverPath, globalServerPath, codexHome, xdgConfig, env };
}

// A generic stdio MCP entry — the shape Claude Code and Cursor both use.
const mcpEntry = (serverPath) => ({ type: "stdio", command: "node", args: [serverPath] });

// ---------------------------------------------------------------- detection

function detectHosts(opts = {}) {
  const c = makeCtx(opts);
  const found = [];
  if (isDir(path.join(c.home, ".claude")) || onPath("claude")) found.push("claude");
  if (isDir(path.join(c.home, ".cursor")) || isDir(path.join(c.targetDir, ".cursor"))) found.push("cursor");
  if (isDir(c.codexHome) || onPath("codex")) found.push("codex");
  if (isDir(path.join(c.xdgConfig, "opencode")) || onPath("opencode") || isFile(path.join(c.targetDir, "opencode.json")))
    found.push("opencode");
  if (isDir(path.join(c.home, ".code_puppy"))) found.push("puppy");
  return found;
}

// ---------------------------------------------------------------- claude code
//
// Verified: https://code.claude.com/docs/en/mcp  (project .mcp.json, {"mcpServers":{...}}, type stdio)
//           https://code.claude.com/docs/en/sub-agents  (.claude/agents/*.md, YAML frontmatter
//           name/description/tools/model; MCP tools referenced as mcp__<server>__<tool>)

function claudeSubagentMd(agent, manifest, prompt, toolNames) {
  const server = manifest.mcpServer;
  // ONLY the graph tools + the host's file-edit tools. No Read/Grep/Glob/Bash — that starvation IS
  // the mechanism (KG-preferred reverts to grepping; see README).
  const tools = [...toolNames.map((t) => `mcp__${server}__${t}`), "Edit", "Write", "MultiEdit"].join(", ");
  const model = (manifest.models.claude || {})[agent.tier] || agent.tier;
  return [
    "---",
    `name: ${agent.name}`,
    `description: ${agent.description}`,
    `model: ${model}`,
    `tools: ${tools}`,
    "---",
    "",
    prompt,
    "",
  ].join("\n");
}

const claudeAdapter = {
  name: "claude",
  label: "Claude Code",
  restricted: true,
  install(c) {
    const out = [];
    const mcpFile = path.join(c.targetDir, ".mcp.json");
    const cfg = readJson(mcpFile, {});
    if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
    cfg.mcpServers[c.manifest.mcpServer] = mcpEntry(c.serverPath);
    writeJson(mcpFile, cfg);
    out.push(`    ${path.relative(c.targetDir, mcpFile)} -> mcpServers.${c.manifest.mcpServer}`);

    const toolNames = probeServerTools(c.serverPath);
    out.push(`    probed ${toolNames.length} MCP tools from the server (tools/list)`);
    for (const agent of c.manifest.agents) {
      const f = path.join(c.targetDir, ".claude", "agents", `${agent.name}.md`);
      writeOut(f, claudeSubagentMd(agent, c.manifest, c.prompt, toolNames));
      out.push(`    ${path.relative(c.targetDir, f)} (tool-restricted subagent)`);
    }
    return out;
  },
  check(c) {
    const problems = [];
    const cfg = readJson(path.join(c.targetDir, ".mcp.json"), {});
    if (!cfg.mcpServers || !cfg.mcpServers[c.manifest.mcpServer]) problems.push(".mcp.json has no 'codegraph' server");
    for (const agent of c.manifest.agents) {
      const f = path.join(c.targetDir, ".claude", "agents", `${agent.name}.md`);
      if (!isFile(f)) problems.push(`missing .claude/agents/${agent.name}.md`);
    }
    return problems;
  },
  done(c) {
    return [
      `  Claude Code: restart it in ${c.targetDir} (approve the project MCP server when prompted).`,
      "    Run /agents to see kg-sonnet and kg-opus, or just ask:",
      '      "Use the kg-sonnet subagent to change the primary chart series color to #FF6B6B and fix the tests."',
    ];
  },
};

// ---------------------------------------------------------------- cursor
//
// Verified: https://cursor.com/docs/context/mcp    (.cursor/mcp.json, {"mcpServers":{name:{command,args,env}}})
//           https://cursor.com/docs/context/rules  (.cursor/rules/*.mdc, frontmatter description/globs/alwaysApply)

const cursorAdapter = {
  name: "cursor",
  label: "Cursor",
  restricted: false,
  install(c) {
    const out = [];
    const f = path.join(c.targetDir, ".cursor", "mcp.json");
    const cfg = readJson(f, {});
    if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
    cfg.mcpServers[c.manifest.mcpServer] = mcpEntry(c.serverPath);
    writeJson(f, cfg);
    out.push(`    ${path.relative(c.targetDir, f)} -> mcpServers.${c.manifest.mcpServer}`);

    const rule = path.join(c.targetDir, ".cursor", "rules", "codegraph-kg-only.mdc");
    writeOut(
      rule,
      [
        "---",
        "description: KG-only workflow — discover code through the codegraph_* MCP tools instead of grep/read.",
        "alwaysApply: false",
        "---",
        "",
        c.prompt,
        "",
      ].join("\n")
    );
    out.push(`    ${path.relative(c.targetDir, rule)} (rule)`);
    out.push("    NOTE: Cursor has no tool-restricted agents — the rule ASKS for KG-only, it cannot");
    out.push("          enforce it. Expect the model to fall back to grep/read (see README: KG-preferred).");
    return out;
  },
  check(c) {
    const problems = [];
    const cfg = readJson(path.join(c.targetDir, ".cursor", "mcp.json"), {});
    if (!cfg.mcpServers || !cfg.mcpServers[c.manifest.mcpServer]) problems.push(".cursor/mcp.json has no 'codegraph' server");
    if (!isFile(path.join(c.targetDir, ".cursor", "rules", "codegraph-kg-only.mdc")))
      problems.push("missing .cursor/rules/codegraph-kg-only.mdc");
    return problems;
  },
  done(c) {
    return [
      `  Cursor: reopen ${c.targetDir}; enable the 'codegraph' MCP server in Settings -> MCP.`,
      "    Attach the rule with @codegraph-kg-only, then describe the scoped change.",
      "    (No tool restriction available — Cursor may still grep.)",
    ];
  },
};

// ---------------------------------------------------------------- codex cli
//
// Verified: https://learn.chatgpt.com/docs/config-file/config-reference
//           ([mcp_servers.<id>] with command/args/env; user config at $CODEX_HOME/config.toml,
//            default ~/.codex/config.toml). AGENTS.md is Codex's project instruction file.

const tomlStr = (s) => JSON.stringify(String(s)); // TOML basic strings == JSON strings for our inputs

/**
 * Minimal, SAFE TOML merge: we only ever touch the `[mcp_servers.codegraph]` table. Everything
 * outside that block is preserved byte-for-byte — we never re-serialize the user's config (a
 * hand-rolled TOML round-trip would eat comments and ordering).
 */
function mergeCodexToml(existing, blockName, body) {
  // The block is normalized (no trailing blank lines) and the whole file is normalized to exactly
  // one trailing newline, so re-running produces a byte-identical file rather than growing it.
  const block = `[${blockName}]\n${body.replace(/\s+$/, "")}`;
  const finish = (s) => s.replace(/\s+$/, "") + "\n";
  if (existing === null || existing.trim() === "") return finish(block);

  const lines = existing.split("\n");
  const header = new RegExp(`^\\s*\\[\\s*${blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]\\s*$`);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return finish(existing.replace(/\s+$/, "") + "\n\n" + block);

  // the block runs until the next table header (or EOF); drop its trailing blank lines
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  let tail = end;
  while (tail > start + 1 && lines[tail - 1].trim() === "") tail--;

  const rest = lines.slice(tail);
  const next = [...lines.slice(0, start), ...block.split("\n")];
  if (rest.length) next.push("", ...rest); // one blank line before whatever followed
  return finish(next.join("\n"));
}

const CG_START = "<!-- codegraph-kit:start -->";
const CG_END = "<!-- codegraph-kit:end -->";

function mergeMarkedSection(existing, body) {
  const section = `${CG_START}\n${body}\n${CG_END}`;
  if (existing === null || existing.trim() === "") return section + "\n";
  const s = existing.indexOf(CG_START);
  const e = existing.indexOf(CG_END);
  if (s !== -1 && e !== -1 && e > s) {
    return existing.slice(0, s) + section + existing.slice(e + CG_END.length);
  }
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + section + "\n";
}

const codexAdapter = {
  name: "codex",
  label: "OpenAI Codex CLI",
  restricted: false,
  install(c) {
    const out = [];
    const f = path.join(c.codexHome, "config.toml");
    const body = `command = ${tomlStr("node")}\nargs = [${tomlStr(c.globalServerPath)}]\n`;
    fs.mkdirSync(c.codexHome, { recursive: true });
    writeOut(f, mergeCodexToml(readIfExists(f), `mcp_servers.${c.manifest.mcpServer}`, body));
    out.push(`    ${f} -> [mcp_servers.${c.manifest.mcpServer}]`);

    const agentsMd = path.join(c.targetDir, "AGENTS.md");
    const section = ["## KG-only agent", "", c.prompt].join("\n");
    writeOut(agentsMd, mergeMarkedSection(readIfExists(agentsMd), section));
    out.push(`    ${path.relative(c.targetDir, agentsMd)} (## KG-only agent section)`);
    out.push("    NOTE: Codex has no tool-restricted agents — the AGENTS.md section is guidance only.");
    return out;
  },
  check(c) {
    const problems = [];
    const toml = readIfExists(path.join(c.codexHome, "config.toml")) || "";
    if (!toml.includes(`[mcp_servers.${c.manifest.mcpServer}]`))
      problems.push(`${path.join(c.codexHome, "config.toml")} has no [mcp_servers.codegraph]`);
    const md = readIfExists(path.join(c.targetDir, "AGENTS.md")) || "";
    if (!md.includes(CG_START)) problems.push("AGENTS.md has no codegraph-kit section");
    return problems;
  },
  done(c) {
    return [
      `  Codex CLI: run 'codex' from ${c.targetDir}. The codegraph_* tools appear via MCP;`,
      "    AGENTS.md carries the KG-only instructions. (No tool restriction available.)",
    ];
  },
};

// ---------------------------------------------------------------- opencode
//
// Verified: https://opencode.ai/docs/mcp-servers/ (mcp.<name> = {type:"local", command:[...], enabled})
//           https://opencode.ai/docs/agents/      (agent.<name> = {description, mode, prompt:"{file:./…}",
//                                                  model:"provider/model-id", tools:{name:boolean}})

const OPENCODE_TOOLS = {
  bash: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  webfetch: false,
  edit: true,
  write: true,
};

const opencodeAdapter = {
  name: "opencode",
  label: "OpenCode",
  restricted: true,
  install(c) {
    const out = [];
    const promptRel = "./.opencode/kg-coder.prompt.md";
    const promptFile = path.join(c.targetDir, ".opencode", "kg-coder.prompt.md");
    writeOut(promptFile, c.prompt + "\n");
    out.push(`    ${path.relative(c.targetDir, promptFile)}`);

    const f = path.join(c.targetDir, "opencode.json");
    const cfg = readJson(f, {});
    if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
    if (!cfg.mcp || typeof cfg.mcp !== "object") cfg.mcp = {};
    cfg.mcp[c.manifest.mcpServer] = { type: "local", command: ["node", c.serverPath], enabled: true };
    if (!cfg.agent || typeof cfg.agent !== "object") cfg.agent = {};
    for (const agent of c.manifest.agents) {
      cfg.agent[agent.name] = {
        description: agent.description,
        mode: "subagent",
        prompt: `{file:${promptRel}}`,
        model: (c.manifest.models.opencode || {})[agent.tier],
        tools: { ...OPENCODE_TOOLS },
      };
    }
    writeJson(f, cfg);
    out.push(`    ${path.relative(c.targetDir, f)} -> mcp.${c.manifest.mcpServer} + agent.{kg-sonnet,kg-opus} (tool-restricted)`);
    return out;
  },
  check(c) {
    const problems = [];
    const cfg = readJson(path.join(c.targetDir, "opencode.json"), {});
    if (!cfg.mcp || !cfg.mcp[c.manifest.mcpServer]) problems.push("opencode.json has no mcp.codegraph");
    for (const agent of c.manifest.agents) {
      if (!cfg.agent || !cfg.agent[agent.name]) problems.push(`opencode.json has no agent.${agent.name}`);
    }
    if (!isFile(path.join(c.targetDir, ".opencode", "kg-coder.prompt.md")))
      problems.push("missing .opencode/kg-coder.prompt.md");
    return problems;
  },
  done(c) {
    return [
      `  OpenCode: run 'opencode' in ${c.targetDir}, then delegate with:`,
      '      @kg-sonnet change the primary chart series color to #FF6B6B and fix the tests',
    ];
  },
};

// ---------------------------------------------------------------- code puppy
//
// Not vendor-documented publicly; this is a straight port of the shapes install.sh already wrote
// (~/.code_puppy/mcp_servers.json, mcp_agent_bindings.json, agents/*.json). Behaviour unchanged.

const puppyAdapter = {
  name: "puppy",
  label: "Code Puppy",
  restricted: true,
  install(c) {
    const out = [];
    const cp = path.join(c.home, ".code_puppy");
    fs.mkdirSync(path.join(cp, "agents"), { recursive: true });

    const serversFile = path.join(cp, "mcp_servers.json");
    const cfg = readJson(serversFile, {});
    if (!cfg.mcp_servers || typeof cfg.mcp_servers !== "object") cfg.mcp_servers = {};
    cfg.mcp_servers[c.manifest.mcpServer] = {
      name: c.manifest.mcpServer,
      type: "stdio",
      command: "node",
      args: [c.globalServerPath],
      // No fixed cwd: the server inherits Code Puppy's launch dir so it auto-detects "the repo I'm
      // in". CODEGRAPH_ROOT is only the fallback (launching from above the indexed subdir).
      env: { CODEGRAPH_ROOT: c.targetDir },
      timeout: 60,
    };
    writeJson(serversFile, cfg);
    out.push(`    ${serversFile} -> mcp_servers.${c.manifest.mcpServer}`);

    const bindFile = path.join(cp, "mcp_agent_bindings.json");
    const bind = readJson(bindFile, { bindings: {} });
    if (!bind.bindings || typeof bind.bindings !== "object") bind.bindings = {};
    for (const agent of c.manifest.agents) {
      if (!bind.bindings[agent.name] || typeof bind.bindings[agent.name] !== "object") bind.bindings[agent.name] = {};
      bind.bindings[agent.name][c.manifest.mcpServer] = { auto_start: true };
    }
    writeJson(bindFile, bind);
    out.push(`    ${bindFile} -> bindings for ${c.manifest.agents.map((a) => a.name).join(", ")}`);

    const { renderPuppy } = require("./render-agents.cjs");
    for (const agent of c.manifest.agents) {
      const f = path.join(cp, "agents", `${agent.name}.json`);
      writeOut(f, JSON.stringify(renderPuppy(agent, c.manifest, c.prompt), null, 2) + "\n");
      out.push(`    ${f}`);
    }
    return out;
  },
  check(c) {
    const cp = path.join(c.home, ".code_puppy");
    const problems = [];
    const cfg = readJson(path.join(cp, "mcp_servers.json"), {});
    if (!cfg.mcp_servers || !cfg.mcp_servers[c.manifest.mcpServer])
      problems.push("~/.code_puppy/mcp_servers.json has no 'codegraph' server");
    for (const agent of c.manifest.agents) {
      if (!isFile(path.join(cp, "agents", `${agent.name}.json`))) problems.push(`missing ~/.code_puppy/agents/${agent.name}.json`);
    }
    return problems;
  },
  done() {
    return [
      "  Code Puppy: restart it, then:",
      "      /agent kg-sonnet",
      '      "Change the primary chart series color to #FF6B6B and fix any tests this breaks."',
    ];
  },
};

// ---------------------------------------------------------------- none / print

const noneAdapter = {
  name: "none",
  label: "generic / unknown host",
  restricted: false,
  install(c) {
    const snippet = JSON.stringify({ mcpServers: { [c.manifest.mcpServer]: mcpEntry(c.serverPath) } }, null, 2);
    return [
      "    No host config was written. Register the server yourself:",
      "",
      `      stdio command:  node ${c.serverPath}`,
      "",
      "      JSON (the shape most hosts accept):",
      ...snippet.split("\n").map((l) => "        " + l),
      "",
      `      KG-only system prompt: ${path.join(c.kitDir, "agents", c.manifest.prompt || "kg-coder.prompt.md")}`,
      "",
      "    If your host supports tool-restricted agents, give the agent ONLY the codegraph_* tools",
      "    plus its file edit/write tools — no grep/read/list/shell. That starvation is the point.",
    ];
  },
  check() {
    return [];
  },
  done() {
    return ["  No host configured — see the snippet above."];
  },
};

const ADAPTERS = {
  claude: claudeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  puppy: puppyAdapter,
  none: noneAdapter,
};

// ---------------------------------------------------------------- public API

function installHost(hostName, opts = {}) {
  const a = ADAPTERS[hostName];
  if (!a) throw new Error(`unknown host '${hostName}' (known: ${HOST_NAMES.join(", ")})`);
  const c = makeCtx(opts);
  const lines = a.install(c);
  return { host: hostName, label: a.label, restricted: a.restricted, lines, done: a.done(c) };
}

function checkHost(hostName, opts = {}) {
  const a = ADAPTERS[hostName];
  if (!a) throw new Error(`unknown host '${hostName}' (known: ${HOST_NAMES.join(", ")})`);
  const c = makeCtx(opts);
  const problems = a.check(c);
  return { host: hostName, label: a.label, ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- CLI

function parseArgv(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") o.host = argv[++i];
    else if (a === "--target") o.target = argv[++i];
    else if (a === "--kit") o.kit = argv[++i];
    else if (a === "--home") o.home = argv[++i];
    else if (a === "--server") o.server = argv[++i];
    else o._.push(a);
  }
  return o;
}

function main(argv) {
  const o = parseArgv(argv);
  const cmd = o._[0] || "detect";
  const opts = { kitDir: o.kit, targetDir: o.target, home: o.home, serverPath: o.server };
  const hosts = (o.host || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (cmd === "detect") {
    const found = detectHosts(opts);
    process.stdout.write(found.join("\n") + (found.length ? "\n" : ""));
    return 0;
  }

  if (cmd === "print") {
    const r = installHost("none", opts);
    r.lines.forEach(log);
    return 0;
  }

  if (cmd === "install") {
    if (!hosts.length) throw new Error("install needs --host <name>[,<name>...]");
    for (const h of hosts) {
      const r = installHost(h, opts);
      log(`==> host: ${r.label}${r.restricted ? "  (tool-restricted agents)" : "  (MCP only — no tool restriction)"}`);
      r.lines.forEach(log);
    }
    return 0;
  }

  if (cmd === "next") {
    // Per-host "what do I do now" text. Pure formatting — writes nothing.
    if (!hosts.length) throw new Error("next needs --host <name>[,<name>...]");
    const c = makeCtx(opts);
    for (const h of hosts) {
      const a = ADAPTERS[h];
      if (!a) continue;
      a.done(c).forEach(log);
    }
    return 0;
  }

  if (cmd === "check") {
    if (!hosts.length) throw new Error("check needs --host <name>[,<name>...]");
    let bad = 0;
    for (const h of hosts) {
      const r = checkHost(h, opts);
      if (r.ok) log(`    [ok]      ${r.label} wiring`);
      else {
        bad++;
        r.problems.forEach((p) => log(`    [MISSING] ${r.label}: ${p}`));
      }
    }
    return bad ? 1 : 0;
  }

  throw new Error(`unknown command '${cmd}' (install|check|detect|print|next)`);
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }
}

module.exports = { detectHosts, installHost, checkHost, probeServerTools, HOST_NAMES, ADAPTERS };
