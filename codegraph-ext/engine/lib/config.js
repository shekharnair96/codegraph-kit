"use strict";
/**
 * .codegraph/config.json — what to index. Created by `codegraph init`, read by `codegraph index`.
 * Patterns are minimal globs: `**` matches any path segment(s), `*` matches within a segment.
 */
const fs = require("fs");
const path = require("path");

const CODEGRAPH_DIR = ".codegraph";
const DB_FILE = "codegraph.db";

const DEFAULT_CONFIG = {
  version: 1,
  include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  exclude: [
    "**/.git/**",
    "**/node_modules/**",
    "**/.codegraph/**",
    "**/codegraph-ext/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/coverage/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.turbo/**",
    "**/.cache/**",
    "**/.vite/**",
    "**/.nx/**",
    "**/storybook-static/**",
    "**/__snapshots__/**",
    "**/*.min.js",
    "**/*.bundle.js",
    "**/*.d.ts",
  ],
  maxFileSize: 1048576,
  extractDocstrings: true,
};

const GITIGNORE_TEMPLATE = `# codegraph-kit index (machine-local; regenerate with: codegraph index)
*.db
*.db-wal
*.db-shm
*.db-journal
verify-cache.json
.cg-reset
`;

function dirFor(root) {
  return path.join(root, CODEGRAPH_DIR);
}
function dbPath(root) {
  return path.join(dirFor(root), DB_FILE);
}
function configPath(root) {
  return path.join(dirFor(root), "config.json");
}
function isInitialized(root) {
  return fs.existsSync(configPath(root));
}

function init(root) {
  const dir = dirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  const created = !fs.existsSync(configPath(root));
  if (created) fs.writeFileSync(configPath(root), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_TEMPLATE);
  return { created, dir };
}

function load(root) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(root), "utf8"));
  } catch (_) {
    /* fall back to defaults */
  }
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    include: Array.isArray(cfg.include) && cfg.include.length ? cfg.include : DEFAULT_CONFIG.include,
    exclude: Array.isArray(cfg.exclude) ? cfg.exclude : DEFAULT_CONFIG.exclude,
  };
}

module.exports = { CODEGRAPH_DIR, DB_FILE, DEFAULT_CONFIG, dirFor, dbPath, configPath, isInitialized, init, load };
