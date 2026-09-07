#!/usr/bin/env node
/**
 * install/render-agents.cjs
 *
 * ONE SOURCE OF TRUTH for the KG-only agent: agents/kg-coder.prompt.md (the system prompt) +
 * agents/manifest.json (the per-tier metadata). Every host rendering is generated from those two.
 *
 * This script regenerates the Code Puppy renderings (agents/kg-sonnet.json, agents/kg-opus.json)
 * so they can stay committed (Code Puppy reads them verbatim) without drifting from the prompt.
 *
 *   node install/render-agents.cjs           # rewrite the JSONs
 *   node install/render-agents.cjs --check   # exit 1 if they are out of sync (no writes)
 */
const fs = require("fs");
const path = require("path");

const KIT = path.resolve(__dirname, "..");
const AGENTS = path.join(KIT, "agents");

function loadSource() {
  const manifest = JSON.parse(fs.readFileSync(path.join(AGENTS, "manifest.json"), "utf8"));
  const promptFile = path.join(AGENTS, manifest.prompt || "kg-coder.prompt.md");
  const prompt = fs.readFileSync(promptFile, "utf8").replace(/\s+$/, "");
  return { manifest, prompt, promptFile };
}

// Code Puppy wants the prompt as a string ARRAY (one entry per line) and a flat tool allowlist.
function renderPuppy(agent, manifest, prompt) {
  return {
    name: agent.name,
    // historical file had a trailing space in display_name; keep the rendering clean instead
    display_name: agent.display,
    description: agent.description,
    tools: ["create_file", "replace_in_file", "agent_share_your_reasoning"],
    system_prompt: prompt.split("\n"),
    model: (manifest.models.puppy || {})[agent.tier],
  };
}

function main(argv) {
  const check = argv.includes("--check");
  const { manifest, prompt } = loadSource();
  let drift = 0;
  for (const agent of manifest.agents) {
    const file = path.join(AGENTS, `${agent.name}.json`);
    const next = JSON.stringify(renderPuppy(agent, manifest, prompt), null, 2) + "\n";
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (prev === next) continue;
    if (check) {
      drift++;
      console.error(`[drift] agents/${agent.name}.json is out of sync with agents/kg-coder.prompt.md`);
    } else {
      fs.writeFileSync(file, next);
      console.log(`rendered agents/${agent.name}.json`);
    }
  }
  if (check) {
    if (drift) {
      console.error("run: node install/render-agents.cjs");
      process.exit(1);
    }
    console.log("[ok] Code Puppy agent JSONs are in sync with agents/kg-coder.prompt.md");
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { loadSource, renderPuppy };
