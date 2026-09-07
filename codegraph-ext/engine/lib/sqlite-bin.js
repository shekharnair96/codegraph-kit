"use strict";
/* Resolve a sqlite3 CLI that supports FTS5. Apple's stock /usr/bin/sqlite3 shipped without
 * FTS5 until recent macOS versions, so "sqlite3" from PATH isn't always usable — probe
 * candidates once and remember the winner. Override with $CODEGRAPH_SQLITE3. */
const { spawnSync } = require("child_process");

let cached = null;
function sqliteBin() {
  if (cached) return cached;
  const cands = [
    process.env.CODEGRAPH_SQLITE3,
    "sqlite3",
    "/opt/homebrew/opt/sqlite/bin/sqlite3",
    "/usr/local/opt/sqlite/bin/sqlite3",
  ].filter(Boolean);
  let present = null;
  for (const c of cands) {
    const r = spawnSync(c, [":memory:", "CREATE VIRTUAL TABLE t USING fts5(x);"], { encoding: "utf8" });
    if (r.status === 0) return (cached = c);
    if (r.status !== null && !r.error) present = present || c;
  }
  if (present)
    throw new Error(
      `sqlite3 found (${present}) but built without FTS5. Install one that has it — ` +
        "macOS: `brew install sqlite`; Debian/Ubuntu: `apt install sqlite3` — " +
        "or point $CODEGRAPH_SQLITE3 at a capable binary."
    );
  throw new Error("no sqlite3 CLI found — install it (`brew install sqlite` / `apt install sqlite3`).");
}

module.exports = { sqliteBin };
