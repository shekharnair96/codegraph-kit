# Demo: KG-only agent vs. plain agent

Two repos, four scoped tasks, eight headless Claude Code runs — every run on a clean tree, every
suite verified green afterwards.

## Demo 1: react-hot-toast (small repo — 28 files, 13 tests)

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

### Results

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

## Demo 2: react-hook-form (mid-size repo — ~6,000 graph nodes, 1,302 tests)

Same protocol against [react-hook-form](https://github.com/react-hook-form/react-hook-form)
(v7.87.0, commit `b564062c`; 120 jest suites, 1302 tests, all green at baseline). The index:
6,086 nodes / 20,166 edges / 4,284 symbol bodies.

**Task A** (`rhf-taskA.md`) — small feature: add the `PROTOTYPE_KEYWORDS` prototype-pollution guard
(already present in `get`/`set`/`unset`) to `src/utils/has.ts`, plus new test assertions — without
touching the three sibling utils that already have it.
**Task B** (`rhf-taskB.md`) — rename with a substring trap: function `getFieldValue` →
`readFieldValue` across definition, import, call sites, and tests, while leaving `getFieldValueAs`
— which lives in the **same file** and contains the old name as a substring — untouched, and
keeping all file names as they are.

### Results

| run | suite after | turns | tool calls | cost (USD) | input tokens (cache reads) | wall |
|---|---|---|---|---|---|---|
| A kg-sonnet | PASS 1302/1302 | **9** | 8 | **0.12** | **65k** | 36s |
| A baseline  | PASS 1302/1302 | 11 | 10 | 0.27 | 217k | 28s |
| B kg-sonnet | PASS 1302/1302 | 18 | 17 | **0.13** | **64k** | 36s |
| B baseline  | PASS 1302/1302 | 18 | 17 | 0.22 | 354k | 46s |

All four produced the correct diff: the guard landed only in `has.ts` + its test, the rename hit
all 12 sites, and `getFieldValueAs` survived intact in every run (`runs/rhf-*.diff`).

Notes, honestly reported:

- On the bigger repo the KG agent's context stays small: **~65k input tokens per task vs 217–354k
  for the baseline** (3–5x), because `codegraph_plan`/`impact`/`read` return exactly the relevant
  sites instead of whole files and grep sweeps. That gap is what grows with repo size — cost
  followed it (roughly half the baseline's on both tasks).
- The kg agent effectively **cannot use the plain `Edit` tool**: Claude Code requires a file to be
  read before editing, and the kg toolset has no `Read` (that's the starvation constraint). In the
  B run it burned 11 failed `Edit` attempts learning this, then recovered with a **single batched
  `codegraph_apply_edit_at_site` call that landed the entire 12-site rename at once** and verified
  green. The failed attempts are why its turn count matches the baseline's; the token/cost gap
  stayed 2x anyway.
- The baseline B run tried a `perl -pi -e` in-place rename first (blocked — not allowlisted), which
  would have corrupted `getFieldValueAs`; its per-occurrence `Edit` fallback got the trap right.
- Building this demo also caught a real kit bug: the body-index's string-literal regex backtracked
  catastrophically and never finished (20+ CPU minutes before it was killed, located via stack
  sampling). The trigger turned out to be small but specific — a single **~450-byte** span in
  `src/__tests__/logic/validateField.test.tsx` holding an RFC-5322 email regex literal, dense with
  backslash escapes and containing all three quote characters inside its character classes. Repo
  size had nothing to do with it; one span was enough. Fixed to linear per-quote patterns (0.48s
  for the whole repo), with that exact literal now pinned as a fixture in the kit's test suite.

## Reproduce

```bash
# demo 1
git clone https://github.com/timolins/react-hot-toast && cd react-hot-toast
npx pnpm@9 install --frozen-lockfile

# demo 2 (needs pnpm 10 — its pnpm-workspace.yaml uses v10 fields)
git clone https://github.com/react-hook-form/react-hook-form && cd react-hook-form
npx pnpm@10 install --frozen-lockfile

# either repo, from its root:
/path/to/codegraph-kit/install.sh "$PWD" --host claude
claude -p "$(cat /path/to/demo/taskA.md)" --agent kg-sonnet \
  --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools mcp__codegraph Edit Write MultiEdit \
  --permission-mode acceptEdits --output-format stream-json --verbose
```

The baseline runs use the same command with `--model sonnet` instead of `--agent kg-sonnet`, and
`--allowedTools Edit Write MultiEdit Read Grep Glob "Bash(npx jest*)" ...` — the full runner
(reset, capture, re-verify, summarize) is a ~30-line bash script; see the per-run
`runs/*.summary.json` for the exact tool breakdown each agent produced.

Costs are one sample per cell, not a benchmark. The private experiment behind the kit ran the same
comparison at n=5 per cell across three task tiers; see [`docs/experiment.md`](../docs/experiment.md).
