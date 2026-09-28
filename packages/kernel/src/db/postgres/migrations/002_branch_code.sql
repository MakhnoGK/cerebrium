-- The per-branch code index. File contents are addressed by hash, a parse by (hash, path),
-- and a branch is a versioned set of path -> parse rows. Nothing here is deleted: a file
-- that leaves a branch invalidates its row, and the parse it pointed at stays readable.
CREATE TABLE code_repos (
  id             TEXT PRIMARY KEY,
  remote_key     TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  default_branch TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Exact bytes: a source may carry a NUL, which text cannot hold.
CREATE TABLE code_blobs (
  hash       TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  content    BYTEA NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE code_units (
  id          TEXT PRIMARY KEY,
  blob_hash   TEXT NOT NULL REFERENCES code_blobs (hash),
  path        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  parsed_at   TEXT,
  parse_error TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (blob_hash, path)
);

CREATE INDEX code_units_unparsed ON code_units (created_at) WHERE parsed_at IS NULL;

CREATE TABLE code_symbols (
  id         TEXT PRIMARY KEY,
  unit_id    TEXT NOT NULL REFERENCES code_units (id),
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  qualified  TEXT NOT NULL,
  signature  TEXT,
  summary    TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  code_hash  TEXT NOT NULL,
  source     TEXT NOT NULL,
  embed_hash TEXT NOT NULL
);

CREATE INDEX code_symbols_unit ON code_symbols (unit_id);
CREATE INDEX code_symbols_name ON code_symbols (name);
CREATE INDEX code_symbols_qualified ON code_symbols (qualified);
CREATE INDEX code_symbols_embed ON code_symbols (embed_hash);
CREATE INDEX code_symbols_bm25 ON code_symbols USING bm25 (
  id,
  (qualified::pdb.simple('stemmer=english')),
  (summary::pdb.simple('stemmer=english'))
) WITH (key_field = 'id');

CREATE TABLE code_defines (
  unit_id    TEXT NOT NULL REFERENCES code_units (id),
  src_symbol TEXT NOT NULL REFERENCES code_symbols (id),
  dst_symbol TEXT NOT NULL REFERENCES code_symbols (id),
  PRIMARY KEY (src_symbol, dst_symbol)
);

CREATE INDEX code_defines_dst ON code_defines (dst_symbol);

CREATE TABLE code_imports (
  unit_id         TEXT NOT NULL REFERENCES code_units (id),
  seq             INTEGER NOT NULL,
  name            TEXT NOT NULL,
  candidate_paths TEXT[] NOT NULL,
  namespace       BOOLEAN NOT NULL,
  by_name         BOOLEAN NOT NULL,
  PRIMARY KEY (unit_id, seq)
);

CREATE TABLE code_calls (
  unit_id       TEXT NOT NULL REFERENCES code_units (id),
  seq           INTEGER NOT NULL,
  src_qualified TEXT NOT NULL,
  callee        TEXT NOT NULL,
  PRIMARY KEY (unit_id, seq)
);

CREATE INDEX code_calls_callee ON code_calls (callee);

CREATE TABLE code_branches (
  repo_id      TEXT NOT NULL REFERENCES code_repos (id),
  branch       TEXT NOT NULL,
  commit_sha   TEXT,
  dirty        INTEGER NOT NULL DEFAULT 0,
  indexed_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  retired_at   TEXT,
  PRIMARY KEY (repo_id, branch)
);

CREATE TABLE code_branch_files (
  repo_id        TEXT NOT NULL,
  branch         TEXT NOT NULL,
  path           TEXT NOT NULL,
  unit_id        TEXT NOT NULL REFERENCES code_units (id),
  valid_from     TEXT NOT NULL,
  invalidated_at TEXT,
  FOREIGN KEY (repo_id, branch) REFERENCES code_branches (repo_id, branch)
);

CREATE UNIQUE INDEX code_branch_files_live
  ON code_branch_files (repo_id, branch, path) WHERE invalidated_at IS NULL;
CREATE INDEX code_branch_files_unit ON code_branch_files (unit_id);
CREATE INDEX code_branch_files_history ON code_branch_files (repo_id, branch, path, valid_from);

-- Keyed by the embedded text rather than the symbol, so a symbol that reappears unchanged
-- in a new parse of its file reuses the vector.
CREATE TABLE code_vectors (
  space_id      SMALLINT NOT NULL REFERENCES vector_spaces (id),
  embed_hash    TEXT NOT NULL,
  embedding     VECTOR NOT NULL,
  model_version TEXT NOT NULL,
  ts            TEXT NOT NULL,
  PRIMARY KEY (space_id, embed_hash)
);

-- Note -> code links resolve per branch by (remote_key, path, qualified); `repo` keeps the
-- name the row was written under.
ALTER TABLE code_refs ADD COLUMN remote_key TEXT;
ALTER TABLE code_refs DROP CONSTRAINT code_refs_pkey;
ALTER TABLE code_refs ADD PRIMARY KEY (src, type, repo, path, qualified);
CREATE INDEX code_refs_target ON code_refs (remote_key, path, qualified);
