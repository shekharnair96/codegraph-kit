# Architecture

`codegraph-kit` is a thin, dependency-free layer on top of a **codegraph SQLite database**
(`<repo>/.codegraph/codegraph.db`). The base DB holds the language-level symbol graph — files,
functions, methods, classes, constants, props, and the `calls` / `references` / `imports` edges
between them. This kit adds overlays, a body-level full-text index, an edit loop, and an MCP
server that exposes it all as first-class tools.

## One source of truth

The MCP server ([`codegraph-mcp.cjs`](../codegraph-ext/codegraph-mcp.cjs)) does **not**
re-implement any logic. Every tool shells out to the matching `.cjs` CLI:

```
codegraph_locate / plan / impact  ->  query.cjs
codegraph_read                    ->  read-context.cjs
codegraph_apply_edit_at_site      ->  apply-at-site.cjs
codegraph_apply / _literal        ->  apply-edits.cjs
codegraph_verify                  ->  verify-affected.cjs
codegraph_test_one                ->  test-one.cjs
```

So the CLIs and the MCP tools can never drift, and either surface works standalone.

## Overlays (built on top of the base DB)

The base DB is **wiped and regenerated** by `codegraph index`, so everything this kit adds is
tagged and idempotently re-applied:

- **#3 prop nodes + `has_prop` edges** — React component prop shapes, which the native graph has
  none of.
- **#4 `covers` / `mocks` edges** — test file → source file, plus which exports each test mocks.
  This is what powers "who tests this?" and the change→covering-test mapping used by `verify`.
- **#6 annotation nodes + `annotates` / `mirrors` / `divergent` / `todo` edges** — sourced from the
  git-tracked [`annotations.json`](../codegraph-ext/annotations.json), which is the **durable**
  institutional memory (the DB is gitignored and regenerated; the JSON is not).

Injected rows are tagged (`nodes.id LIKE 'ext:%'`, `edges.provenance = 'ext'`) so re-running
[`augment.cjs`](../codegraph-ext/augment.cjs) is safe. Run it after every `codegraph index`.

## Body-level full-text index

[`build-body-index.cjs`](../codegraph-ext/build-body-index.cjs) builds `node_body_fts` — a
full-text index over each symbol's **body** (identifiers + literals), not just its
name/signature/docstring. That's what lets `codegraph_locate` answer concept-in-body queries like
"line width / stroke" → the function whose body contains `strokeWidth: 1`, even though its name
never says "stroke". It's dependency-free on purpose (regex tokenizer, camelCase/snake_case split,
hex + quoted-string words kept), so it runs anywhere `sqlite3` + Node + the source tree exist —
including sparse clones with no `node_modules`.

## Edit loop

- **[`apply-at-site.cjs`](../codegraph-ext/apply-at-site.cjs)** — the default path. The model has
  already seen line-numbered code in `plan`/`locate`/`impact` output, so it points at a site by
  `(file, line)` + a small find/replace; the tool fetches that line's context itself. Batched and
  atomic — any bad site writes nothing.
- **[`apply-edits.cjs`](../codegraph-ext/apply-edits.cjs)** — anchored `old → new` replacements
  across multiple files, all-or-nothing, with an optional `--dry` validate-only mode.
- **[`verify-affected.cjs`](../codegraph-ext/verify-affected.cjs)** — maps the working-tree diff to
  its covering tests and returns one compact verdict. **Memoized**: re-running without changing any
  input file returns the cached verdict with no test run, killing the "verify after every
  micro-edit" waste. `--types` also runs a scoped type-check.

## Root resolution & the sandbox lock

Every call resolves the target repo in this order:

1. explicit `projectRoot` arg — "work on THAT repo",
2. autodetect from the current dir — "work on wherever I am",
3. `$CODEGRAPH_ROOT` — install-time fallback (covers monorepo-root launches),
4. this kit's own dir — last resort.

Setting **`CODEGRAPH_LOCK_ROOT`** overrides all of the above: every call is confined to exactly
that path, full stop. This lets an agent that must stay inside an isolated/example repo (e.g. an
A/B experiment sandbox) never reach a real repo, even if it passes a path or cwd resolution is
wrong.
