#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * codegraph-ext/install-hook.cjs — opt-in installer for the cg:ask NUDGE hook.
 *
 * Merges (does NOT clobber) a UserPromptSubmit entry into the user's global
 * ~/.wibey/hooks/hooks.json that runs cg-nudge-hook.cjs. Idempotent; supports
 * --uninstall. The hook only nudges when the session cwd is inside this repo,
 * so installing it globally is safe — it stays silent everywhere else.
 *
 *   npm run cg:install-hook              # install (opt-in)
 *   npm run cg:install-hook -- --uninstall
 *
 * We back up hooks.json before writing. The repo ships the scripts; this writes
 * a single absolute-path reference into your PERSONAL config — nothing global is
 * committed, and other users must run this themselves to opt in.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS_JSON = path.join(os.homedir(), ".wibey", "hooks", "hooks.json");
const HOOK_SCRIPT = path.join(__dirname, "cg-nudge-hook.cjs");
const COMMAND = `node "${HOOK_SCRIPT}"`;
const uninstall = process.argv.includes("--uninstall");

function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
  } catch (_) {
    return { hooks: {} };
  }
}

function isOurs(h) {
  return h && h.type === "command" && typeof h.command === "string" && h.command.includes("cg-nudge-hook");
}

function main() {
  if (!fs.existsSync(HOOK_SCRIPT)) {
    console.error(`hook script missing: ${HOOK_SCRIPT}`);
    process.exit(1);
  }
  const cfg = readCfg();
  cfg.hooks = cfg.hooks || {};
  const list = (cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit || []);

  // strip any prior copy of our hook (idempotent install + clean uninstall)
  for (const group of list) {
    if (Array.isArray(group.hooks)) group.hooks = group.hooks.filter(h => !isOurs(h));
  }
  // drop now-empty groups
  cfg.hooks.UserPromptSubmit = list.filter(g => !Array.isArray(g.hooks) || g.hooks.length > 0);

  if (uninstall) {
    write(cfg);
    console.log("cg:ask nudge hook UNINSTALLED from " + HOOKS_JSON);
    return;
  }

  cfg.hooks.UserPromptSubmit.push({
    hooks: [{ type: "command", command: COMMAND, timeout: 5 }],
  });
  write(cfg);
  console.log("cg:ask nudge hook INSTALLED (opt-in).");
  console.log("  registry: " + HOOKS_JSON);
  console.log("  runs:     " + COMMAND);
  console.log("  scope:    only nudges when cwd contains 'microapps/analytics' (override CG_NUDGE_MARKER)");
  console.log("  remove:   npm run cg:install-hook -- --uninstall");
}

function write(cfg) {
  const dir = path.dirname(HOOKS_JSON);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(HOOKS_JSON)) {
    fs.copyFileSync(HOOKS_JSON, HOOKS_JSON + ".bak");
  }
  fs.writeFileSync(HOOKS_JSON, JSON.stringify(cfg, null, 2) + "\n");
}

main();
