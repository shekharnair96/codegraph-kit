"use strict";
/**
 * File discovery. Walks the tree once, prunes excluded directories early, and returns
 * repo-relative forward-slash paths that match an include pattern and no exclude pattern.
 * Also honours plain directory/file lines from the root .gitignore (no negation, no wildcards).
 */
const fs = require("fs");
const path = require("path");

// Minimal glob -> RegExp. Supports `**` (any depth), `*` (within a segment), `?`, and literals.
function globToRegExp(glob) {
  let re = "";
  let i = 0;
  const g = glob.replace(/^\.\//, "");
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` -> zero or more segments; trailing `**` -> anything
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

function compile(patterns) {
  return patterns.map(globToRegExp);
}
const matchesAny = (rel, res) => res.some(r => r.test(rel));

function readRootGitignore(root) {
  const dirs = new Set();
  const files = new Set();
  try {
    for (const raw of fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("!") || /[*?[\]]/.test(line)) continue;
      const clean = line.replace(/^\//, "").replace(/\/$/, "");
      if (!clean) continue;
      if (line.endsWith("/")) dirs.add(clean);
      else {
        dirs.add(clean);
        files.add(clean);
      }
    }
  } catch (_) {
    /* no .gitignore */
  }
  return { dirs, files };
}

function walk(root, cfg) {
  const inc = compile(cfg.include);
  const exc = compile(cfg.exclude);
  const ignore = readRootGitignore(root);
  const out = [];
  const visit = dirAbs => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dirAbs, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ignore.dirs.has(rel) || ignore.dirs.has(ent.name)) continue;
        // prune early: a directory is skipped when `<rel>/` would be excluded by a `**/x/**` rule
        if (matchesAny(rel + "/x", exc)) continue;
        visit(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ignore.files.has(rel)) continue;
      if (!matchesAny(rel, inc) || matchesAny(rel, exc)) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (_) {
        continue;
      }
      if (st.size > cfg.maxFileSize) continue;
      out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  visit(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

module.exports = { walk, globToRegExp };
