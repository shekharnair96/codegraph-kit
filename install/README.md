# `install/` — host adapters

`install.sh` does the host-neutral work (engine deps, copy `codegraph-ext/` into the repo, build
`.codegraph/codegraph.db`, run the overlays) and then hands off to `install/hosts.cjs`, which knows
how each agent host wants its MCP server registered and — where the host supports it — how to
declare a **tool-restricted** agent.

Plain CJS, zero dependencies, no python.

## One source of truth for the agent

```
agents/kg-coder.prompt.md   the KG-only system prompt (the ONLY copy)
agents/manifest.json        per-tier metadata: name, display, tier, description, per-host model ids
```

Every host rendering is generated from those two files:

| Rendering | Produced by | Committed? |
|---|---|---|
| `agents/kg-{sonnet,opus}.json` (Code Puppy) | `node install/render-agents.cjs` | yes — Code Puppy reads them verbatim |
| `.claude/agents/*.md` (Claude Code subagents) | `install/hosts.cjs` at install time | no, written into the target repo |
| `.cursor/rules/*.mdc`, `.opencode/kg-coder.prompt.md`, `AGENTS.md` section | `install/hosts.cjs` | no |

`node install/render-agents.cjs --check` fails if the committed Code Puppy JSONs have drifted from
the prompt file; `test/hosts.test.cjs` runs it.

## CLI

```bash
node install/hosts.cjs detect  --target <abs> [--kit <abs>]
node install/hosts.cjs install --host claude,opencode --target <abs> [--kit <abs>]
node install/hosts.cjs check   --host <name>[,<name>...] --target <abs>
node install/hosts.cjs next    --host <name>[,<name>...] --target <abs>
node install/hosts.cjs print   --target <abs>
```

`--home` and `--server` exist for tests. Otherwise `$HOME`, `$XDG_CONFIG_HOME` and `$CODEX_HOME`
are honoured normally.

## Which server path gets registered

- **Project-scoped** configs (`.mcp.json`, `.cursor/mcp.json`, `opencode.json`) point at
  `<target>/codegraph-ext/codegraph-mcp.cjs`, so the config travels with the checkout.
- **Global** configs (`~/.code_puppy/mcp_servers.json`, Codex's `config.toml`) are registered once
  for every repo, so they point at the kit's shared copy.

Either way the server resolves the actual repo from its cwd (walk up to a dir having both
`.codegraph/codegraph.db` and `codegraph-ext/`), so one registration serves every indexed repo.

## Merge semantics

All adapters are **idempotent** and **non-destructive**:

- unrelated servers, agents and config keys are preserved (JSON merges touch only the `codegraph`
  key; the TOML merge rewrites only the `[mcp_servers.codegraph]` block and never re-serializes the
  rest of the file, so comments and ordering survive);
- re-running produces a **byte-identical** tree — if the rendered content already matches, no write
  happens at all;
- the first time a pre-existing file is modified it is copied to `<file>.bak-<timestamp>`. Later
  runs make no further backups.

## Tool restriction (the thesis)

The kit's finding is that **KG-*preferred* does not work** — given grep/read as a fallback, the
model greps and ignores the graph. The starvation is the mechanism. So wherever a host can express
a tool allowlist, the installed agent gets **only** the `codegraph_*` MCP tools plus the host's file
edit/write tools.

The Claude Code tool allowlist is built by **probing the server at install time** — `install/hosts.cjs`
spawns `node codegraph-mcp.cjs`, sends `initialize` then `tools/list` over stdio, and uses whatever
tool names come back. Adding a tool to `codegraph-mcp.cjs` therefore needs no change here.

## Verified against vendor docs

Checked while writing these adapters (2026-09-07):

| Host | What was verified | Docs |
|---|---|---|
| **Claude Code** | project `.mcp.json` = `{"mcpServers":{"<name>":{"type":"stdio","command","args","env"}}}`; subagents live at `.claude/agents/*.md` as Markdown with YAML frontmatter `name`, `description`, `tools` (comma-separated allowlist), `model` (`sonnet`/`opus`/…); MCP tools in the allowlist are written `mcp__<server>__<tool>` | <https://code.claude.com/docs/en/mcp>, <https://code.claude.com/docs/en/sub-agents> |
| **OpenCode** | `mcp.<name> = {"type":"local","command":[…],"enabled":true,"environment":{…}}`; `agent.<name> = {description, mode:"primary"\|"subagent"\|"all", prompt:"{file:./relative/path}", model:"provider/model-id", tools:{<tool>:boolean}}`; built-in tool names are `bash, read, grep, glob, list, edit, write, webfetch` | <https://opencode.ai/docs/mcp-servers/>, <https://opencode.ai/docs/agents/>, <https://opencode.ai/docs/config/> |
| **Codex CLI** | `[mcp_servers.<id>]` table with `command`, `args`, `env` (also `cwd`, `enabled`); user config is `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | <https://learn.chatgpt.com/docs/config-file/config-reference> (the canonical redirect target of `developers.openai.com/codex/config-reference`, itself linked from `github.com/openai/codex/blob/main/docs/config.md`) |
| **Cursor** | project MCP config at `.cursor/mcp.json` with `{"mcpServers":{"<name>":{"command","args","env"}}}`; project rules are `.cursor/rules/*.mdc` with frontmatter `description`, `globs`, `alwaysApply` (the `.mdc` extension is required — a plain `.md` in that directory is ignored) | <https://cursor.com/docs/context/mcp>, <https://cursor.com/docs/context/rules> (the `docs.cursor.com/context/…` URLs 308-redirect here) |
| **Code Puppy** | **unverified against docs** — no public config reference was found. The shapes written (`~/.code_puppy/mcp_servers.json` with the snake_case `mcp_servers` wrapper, `mcp_agent_bindings.json`, `agents/*.json`) are a straight port of what this kit's previous python-based `install.sh` already wrote, and are known to work with the version of Code Puppy the experiments were run on. | <https://github.com/mpfaffenberger/code_puppy> |

Two caveats worth knowing:

- **Cursor and Codex CLI cannot restrict tools.** Their adapters install the MCP server plus a
  prompt file (a rule / an `AGENTS.md` section) that *asks* for the KG-only workflow. Per this
  kit's own experiments, expect that to behave like the KG-*preferred* arm — i.e. the model will
  often grep anyway. They are supported for the graph tooling, not for the cost result.
- **Model ids** live in `agents/manifest.json` under `models`. The OpenCode ids use that host's
  `provider/model-id` format; edit them there if your provider is configured differently.
