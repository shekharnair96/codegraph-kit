#!/usr/bin/env bash
#
# codegraph-kit installer
# ------------------------
# Points the codegraph MCP server + the two KG-only agents at a target repo, for whatever
# agent host(s) you actually use.
#
# Usage:
#   ./install.sh /abs/path/to/repo-or-subdir                    # auto-detect hosts (default)
#   ./install.sh /abs/path/to/repo-or-subdir --host claude      # one host
#   ./install.sh /abs/path/to/repo-or-subdir --host claude,opencode
#   ./install.sh --check /abs/path/to/repo-or-subdir            # diagnose only, change nothing
#
# Hosts:  claude | cursor | codex | opencode | puppy | none | auto
#   auto (default)  install for every host detected on this machine; if none is detected,
#                   fall back to `none` and just print the registration snippet.
#
# The target is the directory that holds your source (usually where package.json lives; for a
# monorepo, the package you want indexed). Run this repeatedly for different repos — the host
# wiring is idempotent; each repo gets its own codegraph-ext/ + DB.
#
# The indexing engine lives in codegraph-ext/engine/ (plain Node; its two npm deps — ts-morph and
# typescript — are the kit's own dependencies, installed once). Every target repo shares it;
# nothing needs to be on your PATH.
#
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTS_CLI="$KIT/install/hosts.cjs"
RUNNER_CLI="$KIT/install/detect-runner.cjs"

# --- arg parse: --check anywhere, --host repeatable/comma-separated, first bare arg = target ---
MODE="install"
TARGET=""
HOSTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --host)
      [ $# -ge 2 ] || { echo "ERROR: --host needs a value."; exit 1; }
      HOSTS="${HOSTS:+$HOSTS,}$2"; shift 2 ;;
    --host=*) HOSTS="${HOSTS:+$HOSTS,}${1#--host=}"; shift ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "ERROR: unknown option '$1'"; exit 1 ;;
    *)
      if [ -z "$TARGET" ]; then TARGET="$1"; else echo "ERROR: unexpected argument '$1'"; exit 1; fi
      shift ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (>= 18 required)."; exit 1; }
# --- the indexer writes the graph through the sqlite3 command-line tool ---
node -e "require('$KIT/codegraph-ext/sqlite-bin.cjs').sqliteBin()" || exit 1

if [ -z "$TARGET" ]; then
  echo "Usage: ./install.sh /abs/path/to/repo-or-subdir [--host claude,opencode,...]"; exit 1
fi
[ -d "$TARGET" ] || { echo "ERROR: target '$TARGET' is not a directory."; exit 1; }
TARGET="$(cd "$TARGET" && pwd)"   # normalize to absolute

ENGINE="$KIT/codegraph-ext/engine"
CG_BIN="$ENGINE/bin/codegraph.js"

# Ask the question Node will ask at runtime, rather than testing a literal path: ts-morph and
# typescript are the kit's own dependencies, so from a git clone they land in $KIT/node_modules,
# but from `npm i codegraph-mcp` they're hoisted into the CONSUMER's node_modules, one level
# above the kit. require.resolve from the engine's directory finds them either way.
have_deps() {
  node -e "require.resolve('typescript',{paths:['$ENGINE']});require.resolve('ts-morph',{paths:['$ENGINE']})" 2>/dev/null
}

# --- resolve the host list (auto/empty -> detect; nothing detected -> `none`) ---
if [ -z "$HOSTS" ] || [ "$HOSTS" = "auto" ]; then
  DETECTED="$(node "$HOSTS_CLI" detect --target "$TARGET" --kit "$KIT" | tr '\n' ',' | sed 's/,$//')"
  if [ -n "$DETECTED" ]; then HOSTS="$DETECTED"; else HOSTS="none"; fi
fi

# --- --check: report what's set up vs missing, then exit WITHOUT changing anything ---
if [ "$MODE" = "check" ]; then
  echo "==> codegraph setup check for: $TARGET"
  echo "    hosts: $HOSTS"
  ok=1
  if [ -f "$TARGET/codegraph-ext/read-context.cjs" ] && [ -f "$TARGET/codegraph-ext/codegraph-mcp.cjs" ]; then
    echo "    [ok]      codegraph-ext/ scripts present"
  else
    echo "    [MISSING] codegraph-ext/ scripts  (the MCP server shells out to <root>/codegraph-ext/*.cjs)"; ok=0
  fi
  if [ -f "$TARGET/.codegraph/codegraph.db" ]; then
    echo "    [ok]      .codegraph/codegraph.db present"
  else
    echo "    [MISSING] .codegraph/codegraph.db  (graph index)"; ok=0
  fi
  if have_deps; then
    echo "    [ok]      engine dependencies installed"
  else
    echo "    [MISSING] engine dependencies (run \`npm install\` in $KIT)"; ok=0
  fi
  node "$RUNNER_CLI" check --target "$TARGET" || ok=0
  node "$HOSTS_CLI" check --host "$HOSTS" --target "$TARGET" --kit "$KIT" || ok=0
  if [ "$ok" = "1" ]; then
    echo "==> READY. This repo is fully set up."
    exit 0
  fi
  echo "==> NOT READY. Fix with:  ./install.sh $TARGET   (idempotent; copies scripts + builds index)"
  exit 1
fi

echo "==> [1/5] install the indexing engine's dependencies (once; shared by every target repo)"
if have_deps; then
  echo "    already installed"
else
  # Only reachable from a git clone: installing via npm brings the deps along.
  ( cd "$KIT" && npm install --no-audit --no-fund )
  have_deps || { echo "    ERROR: ts-morph/typescript still unresolvable from $ENGINE"; exit 1; }
  echo "    installed -> $KIT/node_modules"
fi

echo "==> [2/5] copy tooling into target repo"
mkdir -p "$TARGET/codegraph-ext"
# copy scripts; do NOT clobber an existing annotations.json (it's the repo's durable memory).
# The glob is *.cjs on purpose: verify.config.json and annotations.json are the repo's, not the kit's.
for f in "$KIT"/codegraph-ext/*.cjs; do cp "$f" "$TARGET/codegraph-ext/"; done
[ -f "$TARGET/codegraph-ext/annotations.json" ] || cp "$KIT/codegraph-ext/annotations.json" "$TARGET/codegraph-ext/"
echo "    scripts synced -> $TARGET/codegraph-ext/"

echo "==> [3/5] derive the test runner from this repo's own \`npm test\`"
# cg:verify's verdict is only meaningful if it runs the suite this repo actually runs. Without a
# verify.config.json affected.cjs falls back to a bare `npx jest`, which for a repo whose tests
# need a specific --config is a DIFFERENT suite -- green for the wrong reason. Deriving it here (and
# probing it once, for real) makes that failure loud at install time instead of silent forever.
node "$RUNNER_CLI" emit --target "$TARGET"

echo "==> [4/5] build the graph DB (init if needed, index, then overlays)"
node "$CG_BIN" init "$TARGET"                                # idempotent: no-op if already initialized
node "$CG_BIN" index "$TARGET"                               # always (re-)index to latest source
( cd "$TARGET" && node codegraph-ext/augment.cjs ) || echo "    (skipping overlay augment: needs ts-morph resolvable -- core locate/plan/trace/apply/verify still work)"
( cd "$TARGET" && node codegraph-ext/build-body-index.cjs ) || echo "    (skipping body index: will self-heal on first codegraph_read call)"
echo "    DB built -> $TARGET/.codegraph/codegraph.db"

echo "==> [5/5] wire up the agent host(s): $HOSTS"
node "$HOSTS_CLI" install --host "$HOSTS" --target "$TARGET" --kit "$KIT"

echo ""
echo "Done. KG is installed and indexed for:  $TARGET"
echo ""
echo "Next:"
node "$HOSTS_CLI" next --host "$HOSTS" --target "$TARGET" --kit "$KIT"

cat <<EOF

Run this installer on another repo any time — each repo gets its own codegraph-ext/ + DB.

Maintenance:
  - After a big refactor / branch switch, rebuild the graph:
      node $KIT/codegraph-ext/engine/bin/codegraph.js index $TARGET && node $TARGET/codegraph-ext/augment.cjs
  - After you UPDATE the kit's scripts: re-run install.sh $TARGET to re-copy them.
  - Restart the MCP server between unrelated sessions (per-run counters are in-memory).
EOF
