# Demo: KG-only agent vs. plain agent on react-hot-toast

Four headless Claude Code runs against [react-hot-toast](https://github.com/timolins/react-hot-toast)
(commit `f339d71`, 28 files, 13-test jest suite), driven by `claude -p` on a clean tree each time.
Two scoped tasks, each run twice:

- **kg**: the kit's `kg-sonnet` subagent — no grep, no file reads, no shell; discovery and edits only
  through the `codegraph_*` MCP tools.
- **base**: plain Sonnet with Read/Grep/Glob/Edit and jest via Bash. Same prompt.

**Task A** (`taskA.md`) — multi-site default change: remove-delay 1000→1500 ms (defined by two
separate constants in two files) and success duration 2000→3000 ms, without touching docs or the
tests' promise delays.
**Task B** (`taskB.md`) — rename with a substring trap: `ToastBar`→`ToastCard` (+ props interface),
while leaving the styled element `ToastBarBase` alone.

## Results

| run | suite after | turns | tool calls | cost (USD) | wall |
|---|---|---|---|---|---|
| A kg-sonnet | PASS 13/13 | 20 | 19 (all codegraph) | 0.44 | 2m31s |
| A baseline  | PASS 13/13 | 19 | 18 | 0.35 | 1m23s |
| B kg-sonnet | PASS 13/13 | **6** | **5** (all codegraph) | **0.07** | 24s |
| B baseline  | PASS 13/13 | 10 | 9 | 0.11 | 20s |

All four produced the correct minimal diff (`runs/*.diff`); per-run tool-call breakdowns are in
`runs/*.summary.json`. The kg runs used exclusively `mcp__codegraph__*` tools — the starvation
constraint held.

Notes, honestly reported:

- On the **rename** (task B) the KG path was strictly better: one `codegraph_plan` returned the full
  edit set (definition + import + JSX usage + public export, `ToastBarBase` correctly excluded), one
  batched `apply_edit_at_site` landed it — 40% fewer turns and ~40% cheaper than the baseline.
- On the **multi-site value change** (task A) the KG run cost more: it correctly found both duplicate
  constants immediately, but overshot its first fix to a timing-sensitive test and spent ~4 turns
  reasoning back to the minimal edit. The baseline was cheaper on this one.
- A baseline run without test-runner permission (its first attempt used `yarn jest`, which the
  harness hadn't allowlisted) shipped a **red suite while reasoning that the test was fine** — the
  KG agent can't hit that failure mode, because `codegraph_test_one`/`codegraph_verify` are inside
  its own toolset. Worth knowing when you configure a plain agent's permissions.

## Reproduce

```bash
git clone https://github.com/timolins/react-hot-toast && cd react-hot-toast
npx pnpm install --frozen-lockfile
/path/to/codegraph-kit/install.sh "$PWD" --host claude
claude -p "$(cat /path/to/demo/taskA.md)" --agent kg-sonnet \
  --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools mcp__codegraph Edit Write MultiEdit \
  --permission-mode acceptEdits --output-format stream-json --verbose
```

Costs are one sample per cell, not a benchmark; the private experiment behind the kit ran the same
comparison at n=40 per tier.
