-- codegraph-kit indexer: SQLite schema (version 1)
--
-- This is the contract every codegraph-ext/*.cjs script reads. Column names, node/edge kinds
-- and the `file:<relpath>` id convention are the interface; keep them stable.

CREATE TABLE IF NOT EXISTS schema_versions (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);
INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000, 'initial schema');

-- One row per code symbol (and one per file, kind='file').
CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,   -- 'file:<rel>' for files, '<kind>:<hash>' for symbols
    kind            TEXT NOT NULL,      -- file|import|function|method|class|interface|type_alias|enum|enum_member|constant|variable|property|namespace
    name            TEXT NOT NULL,
    qualified_name  TEXT NOT NULL,      -- Outer.Inner.name (no file prefix)
    file_path       TEXT NOT NULL,      -- repo-relative, forward slashes
    language        TEXT NOT NULL,      -- typescript|tsx|javascript|jsx  (overlays use 'ext')
    start_line      INTEGER NOT NULL,   -- 1-based
    end_line        INTEGER NOT NULL,   -- 1-based, inclusive
    start_column    INTEGER NOT NULL,   -- 0-based
    end_column      INTEGER NOT NULL,
    docstring       TEXT,
    signature       TEXT,
    visibility      TEXT,
    is_exported     INTEGER DEFAULT 0,
    is_async        INTEGER DEFAULT 0,
    is_static       INTEGER DEFAULT 0,
    is_abstract     INTEGER DEFAULT 0,
    decorators      TEXT,               -- JSON array
    type_parameters TEXT,               -- JSON array
    updated_at      INTEGER NOT NULL
);

-- Relationships. provenance is NULL for rows the indexer wrote; overlays tag theirs ('ext').
CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    target      TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- contains|imports|calls|references|extends|implements
    metadata    TEXT,                   -- JSON object
    line        INTEGER,
    col         INTEGER,
    provenance  TEXT DEFAULT NULL,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
    path          TEXT PRIMARY KEY,
    content_hash  TEXT NOT NULL,
    language      TEXT NOT NULL,
    size          INTEGER NOT NULL,
    modified_at   INTEGER NOT NULL,
    indexed_at    INTEGER NOT NULL,
    node_count    INTEGER DEFAULT 0,
    errors        TEXT
);

-- Identifiers that resolved to a declaration outside the indexed set (e.g. a dependency).
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id    TEXT NOT NULL,
    reference_name  TEXT NOT NULL,
    reference_kind  TEXT NOT NULL,
    line            INTEGER NOT NULL,
    col             INTEGER NOT NULL,
    candidates      TEXT,
    file_path       TEXT NOT NULL DEFAULT '',
    language        TEXT NOT NULL DEFAULT 'unknown',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_metadata (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind           ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name           ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path      ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language       ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line      ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name     ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_edges_kind           ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind    ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind    ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_provenance     ON edges(provenance);
CREATE INDEX IF NOT EXISTS idx_files_language       ON files(language);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name      ON unresolved_refs(reference_name);

-- Full-text index over names/docs/signatures; kept in sync by triggers so overlays that
-- INSERT into nodes are searchable too.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id, name, qualified_name, docstring, signature,
    content='nodes', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;
