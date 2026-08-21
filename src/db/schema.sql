-- cerebrium schema — DERIVED, human-readable snapshot of the current end state.
-- NEVER executed at runtime: migrations (src/db/migrations/000_baseline -> NNN) are the
-- single source of truth; a fresh DB is built entirely by running them in order. This
-- file exists so the schema is reviewable in one place; a drift-guard test asserts it
-- stays byte-equivalent (normalized) to the schema the migrations actually build. When
-- you add a migration, update this snapshot in the same commit.
-- Columns marked (future) are inert in Phase 1 but present now to avoid migrations.

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
  created_at     TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,      -- times fetched by `get` (importance prior)
  last_used_at TEXT,                         -- last fetch; episodic decays from this
  event_from TEXT,                           -- event axis: when the fact became true (null = unclaimed)
  event_to TEXT                              -- event axis: when it stopped being true
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
  last_seen  TEXT NOT NULL,
  client         TEXT,      -- who wrote: MCP initialize clientInfo, or an internal writer
  client_version TEXT,
  principal_id   TEXT       -- the stable writer behind the session; see principals
);
CREATE INDEX IF NOT EXISTS idx_sessions_principal ON sessions(principal_id, started_at);

-- The writer behind a session, stable across sessions: what a capability profile, a quota
-- and a trust weight attach to. Keyed by the client name the MCP handshake reports.
CREATE TABLE IF NOT EXISTS principals (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
) STRICT;

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

-- Phase 4: Section-level FTS. Maintains an index over individual chunks to support
-- section-level scoring and token-efficient snippet retrieval for text searches.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  chunk_id UNINDEXED, node_id UNINDEXED, text, tokenize='porter unicode61'
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

-- Two vector pools, same space and metric, split by lifecycle and size (migration 013).
-- `chunk_vec` holds authored memory plus curated external mirrors — a few hundred rows,
-- small enough that a KNN can sweep all of it; `code_vec` holds the code-symbol index,
-- which is six orders larger, disposable, and rebuildable by `code_index`. Sharing one
-- table meant every k slot went to code and authored memory was post-filtered to nothing.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[384] distance_metric=cosine  -- dim = provider config (384 = default e5 model)
);

CREATE VIRTUAL TABLE IF NOT EXISTS code_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[384] distance_metric=cosine
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

-- Phase 3a: external mirrors. `mirror_sources` is the per-deployment registry of external
-- sources the agent mirrors (catalog + freshness state), empty in a fresh clone and populated
-- at runtime via the `source_register` tool. `mirror_records` holds the per-record
-- back-reference + deep-link URL + opaque facet JSON for `mirror` nodes whose origin != 'repo'
-- (external mirrors are ordinary `nodes` rows; the node revision is the agent-composed
-- summary). A mirror node's `type` is open vocab (no CHECK) so a new source needs no migration.
CREATE TABLE IF NOT EXISTS mirror_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  label           TEXT,
  project         TEXT,
  freshness_hours INTEGER,
  recipe          TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_synced_at  TEXT,
  registered_at   TEXT NOT NULL,
  invalidated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mirror_sources_kind ON mirror_sources(kind);

CREATE TABLE IF NOT EXISTS mirror_records (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id),
  source_id  TEXT NOT NULL,
  native_id  TEXT NOT NULL,
  url        TEXT,
  facets     TEXT,
  UNIQUE (source_id, native_id)
);
CREATE INDEX IF NOT EXISTS idx_mirror_records_source ON mirror_records(source_id);

CREATE TABLE IF NOT EXISTS consolidation_candidates (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  project       TEXT,
  member_ids    TEXT NOT NULL,
  member_hash   TEXT NOT NULL,
  canonical_id  TEXT,
  score         REAL NOT NULL,
  proposal      TEXT,
  detected_at   TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  last_error    TEXT,
  UNIQUE (member_hash)
);
CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_candidates(status, kind);

-- Write-time attribute enrichment (MemInsight). Per-revision LLM-mined keywords/tags/
-- context the daemon generates for a semantic node and folds into its FTS text for wider
-- recall. Keyed by (node_id, rev) so an `update` re-triggers enrichment on the new rev.
-- A derived side-table (written once per rev, never mutated) — not a `revisions` row.
CREATE TABLE IF NOT EXISTS revision_annotations (
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  rev         INTEGER NOT NULL,
  annotations TEXT NOT NULL,                -- JSON {keywords:[], tags:[], context:""}
  ts          TEXT NOT NULL,
  PRIMARY KEY (node_id, rev)
);

CREATE TABLE IF NOT EXISTS consolidation_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  stage TEXT NOT NULL,
  links_added INTEGER NOT NULL DEFAULT 0,
  links_suggested INTEGER NOT NULL DEFAULT 0,
  links_pruned INTEGER NOT NULL DEFAULT 0,
  distilled INTEGER NOT NULL DEFAULT 0,
  distill_suggested INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  merge_suggested INTEGER NOT NULL DEFAULT 0,
  pruned INTEGER NOT NULL DEFAULT 0,
  prune_suggested INTEGER NOT NULL DEFAULT 0,
  proposals_backfilled INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  annotated INTEGER NOT NULL DEFAULT 0,
  generation_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  merge_delayed INTEGER NOT NULL DEFAULT 0,
  stage_ms TEXT,
  wikilinks_linked INTEGER NOT NULL DEFAULT 0,
  wikilinks_dangling INTEGER NOT NULL DEFAULT 0,
  documents_suggested INTEGER NOT NULL DEFAULT 0,
  documents_linked INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS processes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  pid INTEGER NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  node_version TEXT NOT NULL,
  db_path TEXT NOT NULL,
  config_file TEXT,
  config_state TEXT NOT NULL,
  config_json TEXT NOT NULL,
  model_state TEXT,
  model_ms INTEGER,
  model_error TEXT
) STRICT;
