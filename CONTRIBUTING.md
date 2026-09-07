# Contributing

Thanks for taking a look. This is a small, dependency-light project and it intends to stay that
way, so the bar for new runtime dependencies is high — but bug reports, host integrations and
graph-accuracy fixes are very welcome.

## Getting set up

```bash
git clone https://github.com/shekharnair96/codegraph-kit.git
cd codegraph-kit && npm install
npm test
```

One `npm install` at the root is enough. The indexer under `codegraph-ext/engine/` has no
`package.json` dependencies of its own — it resolves `typescript` and `ts-morph` upward out of the
root `node_modules`, so installing inside that directory does nothing.

You need a `sqlite3` CLI **built with FTS5**. The stock macOS binary is not — `brew install sqlite`
and put `$(brew --prefix sqlite)/bin` ahead of it on your `PATH`. To check:

```bash
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);"
```

The suite takes roughly a minute. It is the real thing, not mocks: it indexes `test-fixture/`
from scratch, queries the resulting database through the `sqlite3` CLI, and drives the actual MCP
server over stdio.

## Tests

Every test lives in `test/` and runs under `node --test`. Files are named explicitly in the `test`
script rather than globbed — Node's default discovery pattern would otherwise pick up
`codegraph-ext/test-one.cjs`, which is a CLI, not a test.

- `test/fixture.test.cjs` — index the fixture, build the overlays, assert graph shape and the
  user-facing `query.cjs` output.
- `test/runner.test.cjs` — the affected-test runner.
- `test/budget.test.cjs` — drives the real MCP server over stdio against two indexed fixture
  copies and asserts the three properties of the per-task call budget.
- `test/hosts.test.cjs` — the generated host configurations.

A change to indexing or query behaviour should come with a fixture case. If you add one, make sure
it fails before your fix: a test that passes against the unpatched code is not testing anything.

## Pull requests

- Keep the diff focused on one thing.
- `npm test` must pass on Linux and macOS — CI runs both.
- Match the surrounding style. There is no linter; the code is plain CommonJS with no build step,
  and comments explain *why*, not *what*.
- New runtime dependencies need a reason in the PR description. The MCP server itself has zero.

## Adding a host

Host configurations are generated from one place — see `install/README.md`. The generator spawns
the server, calls `tools/list`, and uses whatever tool names come back, so adding a host means
adding an emitter, not hard-coding a tool list.

If the host can enforce a tool allowlist (Claude Code, OpenCode and Code Puppy can), wire that up:
KG-only enforcement is the point of the project. Hosts that only support advisory rules should be
documented as advisory in the README's support table, not claimed as enforced.

## Reporting a bug

Include the repo you indexed against (or a minimal reproduction), the `sqlite3 --version` output,
your Node version, and the full command plus its output. Graph-accuracy bugs are the most useful
kind: "symbol X should have been found by `locate` and wasn't" is directly actionable.
