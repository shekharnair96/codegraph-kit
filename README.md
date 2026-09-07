# codegraph-mcp — a standalone code knowledge-graph MCP server and KG-only coding agents

Point the **CodeGraph** MCP server at any TypeScript/JavaScript repo, then hand scoped changes
to one of two **KG-only** coding agents. The agents discover code *only* through the knowledge
graph — no grep, no file listing, no shell — which is exactly what makes them cheap and fast.

## Why KG-only (the short version)

We A/B'd the same scoped task (change a chart's series color + line width, fix the broken
tests) across model × tooling — same repo, same task, correct and tests green in every kept
cell. KG-only Sonnet used ~3.5× fewer tool calls, ~10× fewer tokens and was ~5× cheaper than
the same model with grep/read; KG-only Opus used the fewest turns but cost ~4× KG-only Sonnet.

Takeaways:
- **KG-only Sonnet is the cost winner** — cheapest correct-and-green cell in the grid.
- **KG-only Opus is the fewest-turns winner** — but you pay ~4× for it.
- **KG-*preferred* (grep/read as a fallback) does NOT work**: given the choice, the model greps
  and reads and ignores the graph, reverting to the non-KG baseline. The **starvation** is the
  mechanism, not just a measurement trick. So: **KG-only.**
- **The graph pays off on ambiguous change-location tasks**; on trivial or wide-mechanical edits
  both arms succeed and the graph is overhead.

Full write-up: [`docs/experiment.md`](docs/experiment.md) (also rendered as
[`docs/report.html`](docs/report.html)), the slide deck [`docs/deck.html`](docs/deck.html), charts in
[`docs/figures/`](docs/figures/), and the design notes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Those are relative A/B claims from the private experiment behind this kit. For a small
reproducible **public** demo, see [`demo/README.md`](demo/README.md): four headless runs on
[react-hot-toast](https://github.com/timolins/react-hot-toast), two tasks (a multi-site default
change, and a rename with a substring trap), kg-sonnet vs. a plain agent, with prompts, diffs and
per-run summaries. Honestly reported: on the rename the KG agent used ~40% fewer turns and cost;
on the value change the baseline was slightly cheaper.

## The tools

Each MCP tool shells out to a small, single-purpose `.cjs` CLI under [`codegraph-ext/`](codegraph-ext/),
so there is **one source of truth** for the logic whether you call it as an MCP tool or from the
shell. The target repo is resolved per call as `projectRoot` arg → cwd autodetect → `$CODEGRAPH_ROOT`.

### Discovery (read)

| Tool | What it answers |
|------|-----------------|
| `codegraph_locate` | Turn a *concept* ("graph series color", a hex literal) into ranked candidate **symbols** — searches names, qualified names, docstrings, signatures **and bodies** (identifiers + literals). |
| `codegraph_plan` | The pre-scoped **edit set** for a symbol change: definition + references + covering tests + literal-assert sites, each with the current line inline. |
| `codegraph_impact` | Raw blast-radius set for a symbol (def + prod refs + covering tests + literal-assert sites). |
| `codegraph_read` | The **relevant slices** of many files in ONE call — feed it the `file:line` list from `plan`; a short range auto-expands to its enclosing function/class. |

### Edit + verify (write)

| Tool | What it does |
|------|--------------|
| `codegraph_apply_edit_at_site` | Edit **by (file, line)** — the server fetches that line's context itself, so no whole-file read to build an anchor. Batched, atomic, verifies once. The default edit path. |
| `codegraph_apply` | Apply many **anchored** `old → new` replacements across files in ONE atomic call (all-or-nothing). |
| `codegraph_apply_literal` | One-shot `oldValue → newValue` swap **scoped to a symbol's span**, so changing one metric's color can't leak into siblings. |
| `codegraph_verify` | ONE compact PASS/FAIL verdict over the affected tests for the whole working-tree diff. **Memoized** — unchanged green suites are skipped. |
| `codegraph_test_one` | The raw-output escape hatch: run one test file (optional `-t` name filter) and get jest's full output, only when a failure is genuinely gnarly. |

---

## What's in the box

```
codegraph-kit/
  codegraph-ext/        the tooling: MCP server (codegraph-mcp.cjs), query/verify/apply
                        scripts, DB overlays (augment/build-body-index), starter annotations.json
    engine/             the indexer — walks TS/JS with the TypeScript compiler API and writes
                        .codegraph/codegraph.db
  agents/
    kg-coder.prompt.md  the KG-only system prompt — the ONE source of truth
    manifest.json       the two tiers (name, description, per-host model id)
    kg-sonnet.json      Code Puppy rendering, Sonnet (cost-optimal default choice)
    kg-opus.json        Code Puppy rendering, Opus (fewest turns, ~4× cost)
  install/              host adapters (Claude Code, OpenCode, Code Puppy, Cursor, Codex CLI)
  test/                 a small TS/TSX/JS fixture project + the end-to-end tests (`npm test`)
  docs/                 deck + experiment figures
  install.sh            point everything at a repo (idempotent)
  README.md
```

## Requirements

- **Node ≥ 18**.
- The **`sqlite3` command-line tool** on your PATH (the indexer writes the graph through it).
- **An agent host that speaks MCP.** The installer auto-detects and wires up whichever of Claude
  Code / OpenCode / Code Puppy / Cursor / Codex CLI you have; with none of them it prints a generic
  registration snippet you can paste anywhere. No host is mandatory.
- The target repo must have a working local **test runner** (the agent's `verify` runs it).

(No python. No specific host. The installer is plain Node.)

## Supported hosts

The thesis of this kit is **starvation**: the agent gets no grep, no read, no shell, so it has to
use the graph. Hosts that can express a tool allowlist get that enforced; the rest get the MCP
server plus a prompt file that only *asks* for it.

| Host | What gets installed | KG-only enforced? |
|---|---|---|
| **Claude Code** | project `.mcp.json` + `.claude/agents/kg-{sonnet,opus}.md` subagents whose `tools:` list is exactly the `codegraph_*` MCP tools + `Edit, Write, MultiEdit` | **yes** |
| **OpenCode** | `opencode.json` → `mcp.codegraph` + `agent.kg-{sonnet,opus}` with `tools` disabling bash/read/grep/glob/list/webfetch | **yes** |
| **Code Puppy** | `~/.code_puppy/{mcp_servers,mcp_agent_bindings}.json` + `agents/kg-{sonnet,opus}.json` | **yes** |
| **Cursor** | `.cursor/mcp.json` + `.cursor/rules/codegraph-kg-only.mdc` | no — rules can't restrict tools |
| **Codex CLI** | `$CODEX_HOME/config.toml` `[mcp_servers.codegraph]` + an `AGENTS.md` section | no — no tool allowlist |
| **anything else** | prints the stdio command, an `mcpServers` JSON snippet and the prompt path | you wire it |

On Cursor and Codex CLI expect the model to grep anyway — that's the KG-*preferred* arm, which this
kit measured and found reverts to the non-KG baseline. Use them for the graph tooling, not for the
cost result. Config formats and the docs they were verified against: [`install/README.md`](install/README.md).

The indexer is included: `codegraph-ext/engine/`, plain Node, TS/JS via the TypeScript compiler
API. It has two npm dependencies (`typescript`, `ts-morph`) that `install.sh` installs for you,
once, in the kit — nothing needs to be on your PATH and there is no CLI to download.

If `ts-morph` can't be resolved when the overlays are built, `install.sh` **won't fail** — it
just skips the props/docs/test-linkage/annotation overlays. Core discovery
(`locate`/`plan`/`trace`/`impact`/`apply`/`verify`) works either way.

## Install (once per repo)

```bash
./install.sh /abs/path/to/repo-or-subdir                # auto-detect your host(s)
./install.sh /abs/path/to/repo-or-subdir --host claude   # or name them
./install.sh /abs/path/to/repo-or-subdir --host claude,opencode
```

`repo-or-subdir` = the directory that holds your source (usually where `package.json` lives; for
a monorepo, the package you want indexed).

What it does: copies `codegraph-ext/` into the repo, builds the graph DB (index + overlays), then
registers the `codegraph` MCP server and installs the two KG-only agents for every host it detects
(`--host auto` is the default; `--host none` just prints the snippet). It finishes with a
host-specific "here's how to invoke it" note.

Every merge is idempotent and preserves your existing servers, agents and config keys; the first
time it modifies a pre-existing file it saves a `.bak-<timestamp>` copy beside it.

Run it again for other repos — each repo gets its own `codegraph-ext/` + `.codegraph/` DB.

Check a repo any time without changing anything:

```bash
./install.sh --check /abs/path/to/repo
```

## Send work to an agent

From **inside the repo you're working on**, just send the task — no path needed. The agent
**auto-detects the repo from your current working directory** (it walks up to the nearest indexed
repo).

**Claude Code** — restart it in the repo, approve the project MCP server, then:

```
Use the kg-sonnet subagent to change the primary chart series color to #FF6B6B and set its
line width to 3. Fix any tests this breaks. Don't touch the dashed comparison series.
```

(`/agents` lists `kg-sonnet` and `kg-opus`.)

**OpenCode**:

```
@kg-sonnet change the primary chart series color to #FF6B6B and set its line width to 3,
and fix any tests this breaks
```

**Code Puppy**:

```
/agent kg-sonnet
Change the primary chart series color to #FF6B6B and set its line width to 3.
Fix any tests this breaks. Don't touch the dashed comparison series.
```

Or from an orchestrator:

```python
invoke_agent(agent_name="kg-sonnet",
             prompt="<scoped change>. Fix broken tests.")
```

**Cursor / Codex CLI** have no tool-restricted agents — the `codegraph_*` tools are there, and the
installed rule (`@codegraph-kg-only`) / `AGENTS.md` section asks for the KG-only workflow, but
nothing stops the model grepping.

You only pass an absolute path when you want to target a **different** repo — e.g. "In
`/abs/path/to/other-repo`, \<scoped change\>. Fix broken tests."

Pick `kg-sonnet` to save money, `kg-opus` to minimize turns.

### Good tasks for these agents
Scoped, symbol-level changes: change a constant/color/value, rename, adjust a function's
behavior, and fix the tests that break. They shine when the change location is ambiguous and the
graph can pinpoint the edit set.

### Weak spots (know before you send)
- **JSX/prop wiring** the graph doesn't track — if a value flows through a component prop,
  `trace` from a leaf component can dead-end. The agent is told to trace from the shared
  component's *config* symbol instead, but deeply prop-threaded changes are harder.
- **Brand-new files / greenfield** — there's nothing to discover; a normal agent is fine.
- **Trivial or wide-mechanical edits** — the graph is pure overhead there.

## Run the tests

```bash
npm test
```

from the repo root. `test/fixture.test.cjs` copies `test/fixture/` to a temp dir, indexes it, builds
the overlays, and asserts the graph shape plus `locate`/`trace`/`plan` output end to end.
`test/hosts.test.cjs` runs `install.sh` against a temp repo with `HOME`/`CODEX_HOME` redirected to a
temp dir and asserts every host config parses, that the Claude subagent allowlist really does grant
the `codegraph_*` tools and *not* Read/Grep/Glob/Bash, that re-running is byte-identical, and that
`--check` comes back all `[ok]`. Neither test touches your real host config.

## How it works

- **One shared MCP server**; the target repo is resolved per call as: explicit `projectRoot`
  arg -> **auto-detect from the current working directory** (walk up to the nearest repo that
  has `.codegraph/` + `codegraph-ext/`) -> `$CODEGRAPH_ROOT` fallback. So "work on wherever I
  am" is the default; a path is only for targeting another repo.
- `runScript` executes **`<projectRoot>/codegraph-ext/<script>`** — so each repo carries its
  own copy of the scripts + its own DB. (That's why install.sh copies the kit into the repo.)
- The graph DB (`.codegraph/codegraph.db`) is **self-healing**: `query.cjs` re-applies the
  overlays if a re-index wiped them. `annotations.json` (conventions/decisions/dedupe) is the
  durable, git-committed memory — start empty, grow it as your team learns.
- `apply_edit_at_site` edits **and verifies** in one shot; `verify` gives a single compact
  PASS/FAIL over the whole working-tree diff (memoized, so it's cheap to call once at the end).
- **Fail-fast setup check**: every tool call first checks the target has BOTH `codegraph-ext/`
  *and* `.codegraph/codegraph.db`. If not, you get ONE actionable line (`run install.sh <root>`)
  instead of a cryptic `read-context.cjs not found` from deep inside a script.
- **Discovery failures are soft, never fatal**: `locate`/`trace`/`plan`/`impact`/`read` never
  return a hard error — some hosts (e.g. pydantic-ai based ones) turn a hard tool error into a retry
  and crash the run at `max_retries`. A bad trace path or not-yet-indexed repo now *teaches* the agent (e.g. trace
  dead-ends at a JSX/prop boundary get a hint to trace the shared component's config symbol).
- **Reset is ORCHESTRATOR-ONLY** (agents can't reset their own budgets — they'd just do it to
  escape a READ/LOCATE cap and keep spiralling). To start a new task / clear a stale latch,
  the orchestrator drops a flag file: `touch <root>/.codegraph/.cg-reset` before re-invoking;
  the server consumes it on the next call (clears PASS-latch + budgets + memo, deletes the flag).
  **Never `kill` the stdio server** to reset (that closes the pipe the agent host's MCP manager
  holds and throws `ClosedResourceError` mid-call) — use the flag file.

## Maintenance / gotchas (learned the hard way)

- **Check a repo's setup any time**: `./install.sh --check /abs/path/to/repo` — reports whether
  `codegraph-ext/`, the DB, the engine deps and each host's MCP/agent wiring are all present, and
  makes no changes. Add `--host <name>` to check one host.
- **Editing the agent prompt**: change `agents/kg-coder.prompt.md` (the single source of truth), then
  `node install/render-agents.cjs` to regenerate the committed Code Puppy JSONs, then re-run
  `install.sh <repo>` to push it to the other hosts.
- **After a big refactor or branch switch**, rebuild the DB:
  `node <kit>/codegraph-ext/engine/bin/codegraph.js index <repo> && node <repo>/codegraph-ext/augment.cjs`
- **After you update the kit's scripts**, re-run `install.sh <repo>` to re-copy them into the
  repo. Note the `.cjs` files are git-tracked in the repo, so a `git restore .` will revert
  them — restore `src/` only.
- **Restart the MCP server between unrelated sessions** — per-run counters (budgets, PASS
  latch) live in the server's memory. They auto-reset when the tree goes clean after an edit
  (tracked changes only — untracked junk no longer wedges the latch), OR the orchestrator drops
  a `<root>/.codegraph/.cg-reset` flag file to clear them explicitly (agents cannot self-reset).
  **Do NOT `kill` the stdio process** to reset — that closes the pipe the host holds
  (`ClosedResourceError`); use the flag file.
- **`verify` needs the repo's tests to run locally** — if the test runner is broken in the repo,
  verify can't help the agent.

## License

MIT — see LICENSE.
