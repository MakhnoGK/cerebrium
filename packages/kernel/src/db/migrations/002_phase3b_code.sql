-- Phase 3b — code indexing. Adds operational tables for the kernel-side, in-process
-- repo indexer: a per-file content hash (skip unchanged files on re-index) and the
-- structured facets + raw source for `symbol` mirror nodes. Idempotent (IF NOT EXISTS);
-- mirrors the end state in schema.sql. No existing table is altered — symbols are
-- ordinary `nodes` rows (memory_kind='mirror', type='symbol') plus a `symbols` facet row.

-- Per-file content hash -> skip unchanged files on re-index. DB-only operational state.
CREATE TABLE IF NOT EXISTS code_files (
  repo        TEXT NOT NULL,        -- logical repo name (see MEMORY_CODE_ROOTS)
  path        TEXT NOT NULL,        -- repo-relative posix path
  lang        TEXT NOT NULL,
  hash        TEXT NOT NULL,        -- sha256 of file bytes
  indexed_at  TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);

-- Structured detail for symbol nodes. The NODE holds the summary as its revision
-- content (FTS + embedded); this table holds the structured facets and raw source.
CREATE TABLE IF NOT EXISTS symbols (
  node_id     TEXT PRIMARY KEY REFERENCES nodes(id),
  repo        TEXT NOT NULL,
  path        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,        -- function|method|class|interface|type|enum|const|trait|module
  name        TEXT NOT NULL,        -- simple name, e.g. 'AuthService'
  qualified   TEXT NOT NULL,        -- e.g. 'auth/auth.service.ts:AuthService.validate'
  signature   TEXT,                 -- one-line signature
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  code_hash   TEXT NOT NULL,        -- sha256 of the symbol's own source slice
  source      TEXT NOT NULL         -- the raw source slice, retrievable via get
);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_path ON symbols(repo, path);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(repo, qualified);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(repo, name);
