-- 000_baseline — frozen snapshot of the schema as of 2026-07-17, the point at which
-- migrations became the single source of truth. FRESH databases build from here by
-- running 000 -> NNN in order. This file is IMMUTABLE: never edit it again — any change
-- goes in a new numbered migration. On an existing DB (which already has 001–006
-- recorded) this runs as an idempotent no-op and is simply recorded.
--
-- The living, human-readable end-state snapshot is src/db/schema.sql (never executed;
-- kept accurate by the drift-guard test). This baseline is byte-comparable to the
-- schema.sql that existed when it was frozen.

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,            -- ULID
  memory_kind    TEXT NOT NULL CHECK (memory_kind IN ('episodic','semantic','mirror')),
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  project        TEXT,                        -- nullable = global
  origin         TEXT,                        -- (future) 'jira'|'notion'|'repo'|null
  external_id    TEXT,                        -- (future) upsert key for mirrors
  synced_at      TEXT,                        -- (future)
  valid_from     TEXT NOT NULL,
  invalidated_at TEXT,                        -- soft delete / superseded
  consolidated_at TEXT,                       -- (future) episodic only
  pending_embedding INTEGER NOT NULL DEFAULT 1, -- (future, Phase 2 consumes)
  created_by_session TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  node_id    TEXT NOT NULL REFERENCES nodes(id),
  rev        INTEGER NOT NULL,                -- 1,2,3... per node
  content    TEXT NOT NULL,                   -- markdown body
  session_id TEXT NOT NULL,
  reason     TEXT,                            -- optional: why this edit
  ts         TEXT NOT NULL,
  PRIMARY KEY (node_id, rev)
);

CREATE TABLE IF NOT EXISTS edges (
  src        TEXT NOT NULL REFERENCES nodes(id),
  dst        TEXT NOT NULL REFERENCES nodes(id),
  type       TEXT NOT NULL,   -- 'references'|'documents'|'derived_from'|'supersedes'|'relates_to'|'similar_to'
  provenance TEXT NOT NULL,   -- 'agent'|'system'
  weight     REAL NOT NULL DEFAULT 1.0,
  valid_from TEXT NOT NULL,
  invalidated_at TEXT,
  session_id TEXT NOT NULL,
  PRIMARY KEY (src, dst, type)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project    TEXT,
  started_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action     TEXT NOT NULL,   -- see lib/vocab.ts EVENT_ACTIONS
  node_id    TEXT,
  detail     TEXT,            -- small JSON blob
  ts         TEXT NOT NULL
);

-- FTS over CURRENT revisions only. Maintained manually in the same transaction
-- as writes (delete old row, insert new) — not by triggers, so the logic stays
-- explicit and testable.
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  node_id UNINDEXED, title, content, tokenize='porter unicode61'
);

-- Phase 2: retrieval. Chunk text + vectors for hybrid search. The vec0 virtual
-- table requires the sqlite-vec extension to be loaded first (see db/database.ts).
-- Embeddings are computed asynchronously by the in-process worker; a node is
-- fully findable via FTS while its vectors are still pending.
CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,            -- content-addressed: sha256(node_id + heading_path + text) prefix
  node_id      TEXT NOT NULL REFERENCES nodes(id),
  rev          INTEGER NOT NULL,            -- revision this chunk belongs to
  heading_path TEXT,                        -- 'H2: Ranking > H3: Decay' or null
  seq          INTEGER NOT NULL,            -- order within node
  text         TEXT NOT NULL,
  stale        INTEGER NOT NULL DEFAULT 0   -- 1 when a newer revision dropped this chunk
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[384] distance_metric=cosine  -- dim = provider config (384 = default e5 model)
);

CREATE TABLE IF NOT EXISTS embedding_meta (
  chunk_id      TEXT PRIMARY KEY,
  model         TEXT NOT NULL,
  model_version TEXT NOT NULL,
  ts            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embedding_queue (
  node_id     TEXT PRIMARY KEY,             -- queue is per-node, latest rev wins
  enqueued_at TEXT NOT NULL,                -- also the not-before time for retries
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
CREATE INDEX IF NOT EXISTS idx_nodes_kind_type ON nodes(memory_kind, type);
CREATE INDEX IF NOT EXISTS idx_revisions_node ON revisions(node_id, rev);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id, stale);

-- Phase 3b: code indexing. `code_files` is per-file operational state (content hash
-- -> skip unchanged files on re-index); `symbols` holds the structured facets + raw
-- source for `symbol` mirror nodes (memory_kind='mirror', type='symbol'). The node's
-- revision content is a compact summary (FTS + embedded); the raw source lives here
-- and is only returned via `get`. Symbols are written by the in-process indexer via
-- the repo layer, never through the `write` tool.
CREATE TABLE IF NOT EXISTS code_files (
  repo        TEXT NOT NULL,
  path        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  indexed_at  TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);

CREATE TABLE IF NOT EXISTS symbols (
  node_id     TEXT PRIMARY KEY REFERENCES nodes(id),
  repo        TEXT NOT NULL,
  path        TEXT NOT NULL,
  lang        TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,        -- function|method|class|interface|type|enum|const|trait|module
  name        TEXT NOT NULL,
  qualified   TEXT NOT NULL,
  signature   TEXT,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  code_hash   TEXT NOT NULL,
  source      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_path ON symbols(repo, path);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(repo, qualified);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(repo, name);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,   -- migration filename, e.g. '001_foo.sql'
  applied_at TEXT NOT NULL
);

-- Single-writer election for background work (the async embedding drain). Each
-- stdio server process runs its own worker; this lease ensures only one of them
-- drains the queue at a time, so N idle sessions don't all write in lockstep. A
-- holder renews every tick; if it dies, the lease expires and another takes over.
-- Not the agent-facing advisory-lease feature (that is a later phase) — this is
-- internal process coordination only.
CREATE TABLE IF NOT EXISTS worker_lease (
  role       TEXT PRIMARY KEY,   -- e.g. 'embedding'
  owner      TEXT NOT NULL,      -- worker instance id
  expires_at TEXT NOT NULL
);

-- Per-repo indexing provenance (Phase 3b add-on): which git branch/commit the
-- current index reflects. Informational only — symbols remain branch-agnostic
-- (keyed by repo/path/qualified). One row per repo, rewritten every index run.
CREATE TABLE IF NOT EXISTS code_repos (
  repo       TEXT PRIMARY KEY,
  root       TEXT,               -- absolute repo path; lets re-index by name without MEMORY_CODE_ROOTS
  branch     TEXT,
  commit_sha TEXT,
  dirty      INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);
