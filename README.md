# codegraph-mcp

A **dependency-free [MCP](https://modelcontextprotocol.io) server** that surfaces a codebase's
symbol graph — and a full symbol-aware edit loop — as **first-class agent tools**, sitting right
next to `grep` and `read_file` in the model's tool list.

The whole point: an agent reaches for a native tool by reflex, but ignores an npm script it has to
construct through a generic shell and then text-parse. Same logic, better surface. Instead of
"grep, then read six whole files to reconstruct the answer with certainty", the agent asks the
graph one question and gets back exactly the lines that matter — a big context-token win on every
turn (see [Why it matters](#why-it-matters)).

> Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio convention). **No external
> dependencies** — just Node + `sqlite3` + your source tree.

---

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

## Quick start

### 1. Prerequisites
- **Node** ≥ 16 and **sqlite3** on `PATH`.
- A built codegraph **SQLite DB** for your repo at `<repo>/.codegraph/codegraph.db` (produced by
  your base `codegraph index` step), plus this kit's overlays applied — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### 2. Drop the kit into your repo
Copy the [`codegraph-ext/`](codegraph-ext/) folder to the **root** of the repo you want to index,
so the layout is `<repo>/codegraph-ext/*.cjs`. Build the body index + overlays:

```bash
node codegraph-ext/build-body-index.cjs   # full-text index over symbol bodies
node codegraph-ext/augment.cjs            # covers/mocks + prop + annotation overlays
```

### 3. Register the MCP server with your agent
Point your MCP-capable client at the server over stdio:

```jsonc
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph-ext/codegraph-mcp.cjs"],
      "env": { "CODEGRAPH_ROOT": "/absolute/path/to/your/repo" }
    }
  }
}
```

- `projectRoot` can be passed **per call** to point at any checkout/clone.
- Set `CODEGRAPH_LOCK_ROOT` to **hard-confine** every call to a single path (e.g. an isolated
  sandbox) — explicit `projectRoot` args and cwd autodetection are then ignored.

### 4. (Optional) the nudge hook
`node codegraph-ext/install-hook.cjs` opt-in installs a `UserPromptSubmit` hook that nudges the
agent to prefer the graph. It only fires when the session cwd is inside the repo, so installing it
is safe everywhere else. Uninstall with `--uninstall`.

---

## Why it matters

A controlled A/B experiment on a real production TypeScript/React codebase found that giving a
coding agent this graph — **instead** of letting it grep/read files — turned the cheaper model
(Sonnet) from the *most expensive, worst-behaving* option into the **cost-optimal** one: ~5×
cheaper than non-KG Sonnet and ~4× cheaper than KG Opus, at matching correctness. The full
write-up (method, results, significance tests, and the tuning log) is in
[`docs/experiment.md`](docs/experiment.md) — also rendered as
[`docs/report.html`](docs/report.html) / [`docs/report.pdf`](docs/report.pdf).

Reach for [`token-bench.cjs`](codegraph-ext/token-bench.cjs) to quantify the win on **your** repo.
It's zero-config: it auto-discovers the highest-fan-in questions (the most-mocked module, the
most-covered source file, the widest prop surface, a documented symbol) and, for each, compares:

- **naive** — a grep listing **plus the full text of every file** you'd have to open to reconstruct
  the answer with certainty, and
- **cg:ask** — the exact stdout the overlay hands back for the same question.

```bash
node codegraph-ext/token-bench.cjs
```

The graph turns "open N files and hope" into "ask one question, get the exact lines" — fewer
tokens per turn, fewer wrong-file detours, and edits that are scoped to a symbol's span so a change
can't silently leak into a sibling.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the overlays are built and kept fresh.

---

## Layout

```
codegraph-ext/
  codegraph-mcp.cjs     # the MCP server (stdio JSON-RPC) — wraps the CLIs below
  query.cjs             # locate / plan / impact / docs / covers / mocks / props / notes
  read-context.cjs      # relevant multi-file slices in one call
  apply-at-site.cjs     # edit by (file, line) — the default edit path
  apply-edits.cjs       # anchored multi-file atomic edits
  build-body-index.cjs  # full-text index over symbol BODIES (identifiers + literals)
  augment.cjs           # covers/mocks + prop + annotation overlays
  verify-affected.cjs   # one memoized PASS/FAIL verdict over affected tests
  test-one.cjs          # raw jest output for one file (escape hatch)
  affected.cjs          # shared change→covering-test mapping (library)
  cg-graph.cjs          # interactive HTML change-impact graph
  install-hook.cjs      # opt-in nudge-hook installer
  cg-nudge-hook.cjs     # the nudge hook itself
  token-bench.cjs       # quantify context-token savings vs. naive grep+read
  annotations.json      # hand-authored institutional memory (conventions/decisions/dedupe)
```

## License

MIT — see [`LICENSE`](LICENSE).
