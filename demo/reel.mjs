#!/usr/bin/env node
// reel.mjs — turn a `claude -p ... --output-format stream-json --verbose` NDJSON
// stream (read on stdin) into a short, legible "reel" of tool calls plus a final
// cost/turn summary, for the codegraph-kit demo recording.
//
// Zero dependencies. Robust to partial/interleaved lines: input is buffered and
// only split on '\n'; any line that isn't valid JSON is silently skipped.
//
// Usage:
//   cat demo/runs/rhf-taskB-kg.stream.jsonl | node demo/reel.mjs
//
// Env:
//   REEL_DELAY_MS   ms to sleep between printed tool-call lines (default 450).
//                   Set to 0 for instant/batch output (e.g. when piping to a file).
//   REEL_BASELINE_SUMMARY   path to a baseline summary.json to render the
//                   comparison line from (default: demo/runs/rhf-taskB-base.summary.json
//                   relative to this script, if it exists).

import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DELAY_MS = Number(process.env.REEL_DELAY_MS ?? 450);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny ANSI helpers (no chalk/picocolors — zero deps) ------------------
const isTTY = process.stdout.isTTY || process.env.FORCE_COLOR;
const c = (code, s) => (isTTY || process.env.FORCE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);
const yellow = (s) => c('33', s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Downstream consumer (e.g. `| head`) can close the pipe early; don't crash on it.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});

// ---- description / outcome extraction (generic, not hardcoded to one run) -

function shortToolName(name) {
  return name.replace(/^mcp__codegraph__/, '');
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Summarize a tool_use's input into a short human-readable phrase.
function describeInput(name, input) {
  const short = shortToolName(name);
  if (!input || typeof input !== 'object') return '';
  if (short === 'codegraph_plan') {
    return [input.symbol, input.change].filter(Boolean).join(' — ');
  }
  if (short === 'codegraph_read') {
    const targets = Array.isArray(input.targets) ? input.targets : [];
    return truncate(targets.join(', '), 60);
  }
  if (short === 'codegraph_apply_edit_at_site') {
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    return `${n} edit${n === 1 ? '' : 's'}${input.verify ? ' (+ verify)' : ''}`;
  }
  if (short === 'codegraph_test_one' || short === 'codegraph_impact') {
    return input.file || input.symbol || '';
  }
  if (input.file_path) return truncate(input.file_path, 60);
  if (input.file) return truncate(input.file, 60);
  if (input.symbol) return truncate(input.symbol, 60);
  if (input.path) return truncate(input.path, 60);
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  return truncate(JSON.stringify(input), 60);
}

// Extract a short outcome tag from a tool_result's text content.
function describeOutcome(text, isError) {
  if (isError) return { label: 'FAIL', color: red };
  if (typeof text !== 'string' || text.length === 0) return { label: 'OK', color: green };

  let label = null;
  let color = green;
  let m;

  const applied = text.match(/applied\s+(\d+)\s+edit\(s\)\s+across\s+(\d+)\s+file/i);
  if (applied) label = 'OK';

  if ((m = text.match(/(\d+)\s+passed,\s*(\d+)\s+total/i)) && Number(m[2]) > 0) {
    label = `${m[1]}/${m[2]} PASS`;
  } else if ((m = text.match(/verdict:\s*(PASS|FAIL)/i))) {
    const v = m[1].toUpperCase();
    label = v;
    color = v === 'PASS' ? green : red;
  }

  if (label === null) {
    const okCount = (text.match(/^\s*OK\s+#\d+/gm) || []).length;
    if (okCount > 0) label = `${okCount} site(s) OK`;
    else {
      const siteCount = (text.match(/^\s*-\s+\S+:\d+\s+\(/gm) || []).length;
      if (siteCount > 0) label = `${siteCount} site(s) found`;
    }
  }

  if (label === null) label = 'OK';
  return { label, color };
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

// ---- stream parsing ---------------------------------------------------

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const pending = new Map(); // tool_use_id -> { name, input }
  let resultEvent = null;

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // ignore unparseable / partial lines
    }

    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_use') {
          pending.set(block.id, { name: block.name, input: block.input });
        }
      }
    } else if (evt.type === 'user' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type !== 'tool_result') continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);

        const short = shortToolName(call.name);
        const argSummary = describeInput(call.name, call.input);
        const text = toolResultText(block.content);
        const outcome = describeOutcome(text, block.is_error === true);

        const namePad = short.padEnd(30);
        const argPad = truncate(argSummary, 34).padEnd(34);
        process.stdout.write(
          `  ${dim('>')} ${cyan(namePad)} ${argPad} ${outcome.color(outcome.label)}\n`
        );
        if (DELAY_MS > 0) await sleep(DELAY_MS);
      }
    } else if (evt.type === 'result') {
      resultEvent = evt;
    }
  }

  if (!resultEvent) {
    process.stderr.write('reel: warning — no final "result" event found in stream\n');
    return;
  }

  const turns = resultEvent.num_turns;
  const cost = resultEvent.total_cost_usd;
  const cacheRead = resultEvent.usage?.cache_read_input_tokens ?? 0;
  const inputK = Math.round(cacheRead / 1000);

  process.stdout.write('\n');
  await sleep(DELAY_MS);
  process.stdout.write(
    bold(`  ${turns} turns · $${cost.toFixed(2)} · ${inputK}k input tokens\n`)
  );

  const baselinePath =
    process.env.REEL_BASELINE_SUMMARY ||
    path.join(__dirname, 'runs', 'rhf-taskB-base.summary.json');
  if (existsSync(baselinePath)) {
    try {
      const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
      const bTurns = base.num_turns;
      const bCost = base.cost_usd;
      const bInputK = Math.round((base.usage?.cache_read_input_tokens ?? 0) / 1000);
      process.stdout.write(
        dim(
          `  baseline, same task: ${bTurns} turns · $${bCost.toFixed(2)} · ${bInputK}k input tokens\n`
        )
      );
    } catch {
      // best-effort only — never crash the reel over the comparison line
    }
  }
}

main();
