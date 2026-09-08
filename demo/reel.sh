#!/usr/bin/env bash
# reel.sh — the banner + replay used by demo/reel.tape.
#
# This does NOT call the `claude` CLI. It replays the NDJSON stream captured by
# a real, live run (demo/runs/rhf-taskB-kg.stream.jsonl) through demo/reel.mjs,
# so the recording is free and reproducible. The command shown below is the
# exact one that produced that stream — see demo/README.md for the full
# transcript and demo/runs/*.summary.json for the raw numbers.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo '$ claude -p "rename getFieldValue -> readFieldValue" --agent kg-sonnet \'
echo '    --allowedTools mcp__codegraph Edit Write MultiEdit'
echo '                   ^ no Read. no Grep. no Bash.'
echo
node reel.mjs < runs/rhf-taskB-kg.stream.jsonl
