# codegraph-kit indexer

Builds `.codegraph/codegraph.db`, the SQLite knowledge graph every `codegraph-ext/*.cjs` script
and the MCP server query. Plain Node, two public npm dependencies (`typescript` for extraction,
`ts-morph` for the overlay builder), and the `sqlite3` command-line tool for writing.

```
node bin/codegraph.js init [path] -i     # create .codegraph/ and index
node bin/codegraph.js index [path]       # full rebuild
node bin/codegraph.js stats [path]
node bin/codegraph.js query <name> [path]
```

Those two dependencies are declared once, by the **kit's root `package.json`** — not here — so there
is a single source of truth for their versions. Node resolves them upward from this directory, which
works whether they landed in the kit's own `node_modules` (git clone) or in the consumer's
(`npm i codegraph-kit`). `install.sh` installs them once and calls the binary by absolute path, so
nothing needs to be on `PATH`.

## What it extracts

Languages: TypeScript, TSX, JavaScript, JSX (`.ts .tsx .js .jsx .mjs .cjs .mts .cts`).

| node kind | from |
|---|---|
| `file` | every indexed file (`id = file:<relpath>`) |
| `import` | each `import` statement |
| `function` | function declarations, and `const x = () => …` / `function` expressions (also through `memo(…)`, `forwardRef(…)`) |
| `class`, `method`, `property` | classes and their members |
| `interface`, `property` | interfaces and their members |
| `type_alias`, `enum`, `enum_member`, `namespace` | as named |
| `constant` / `variable` | `const` / `let`,`var` declarations with a non-function initializer |

| edge kind | meaning |
|---|---|
| `contains` | file → symbol, class → member, function → nested declaration |
| `imports` | file → import node, and file → resolved target file (also for `export … from`) |
| `calls` | enclosing symbol → callee (call, `new`, JSX tag, tagged template) |
| `references` | enclosing symbol → any other resolved identifier use |
| `extends`, `implements` | class/interface heritage |

Identifiers are resolved with the TypeScript checker, so references follow imports, re-exports,
`tsconfig` path aliases and index files. Only binding runs: no type-checking, no `lib.d.ts`, no
`@types`, so a large repo indexes in seconds to a minute. Edges the indexer writes have
`provenance = NULL`; overlays written by `augment.cjs` are tagged `'ext'` and survive a
re-index via `query.cjs`'s self-heal.

## Configuration

`.codegraph/config.json` (created by `init`): `include` / `exclude` globs (`**` and `*`),
`maxFileSize`, `extractDocstrings`. Plain directory lines in the root `.gitignore` are honoured
too. A `tsconfig.json` / `jsconfig.json` at the root is read for `paths`, `baseUrl` and JSX
settings.

## Known limits

- JSX prop threading is not a graph edge: a value that flows through a component prop shows as
  a `references` edge on the prop *expression*, not on the receiving component's parameter.
- Dynamic `import()` behind a runtime string and string-keyed registries are invisible by
  construction. `query.cjs` falls back to a word-boundary grep for those.
- Only TS/JS. Other languages index as nothing (files are skipped).
