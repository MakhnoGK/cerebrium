-- The Postgres store: the same schema semantics as SQLite after 033, not a replay of its
-- migrations. Timestamps are ISO-8601 TEXT and are compared as text, which is why the
-- database must use a byte-order collation (checked at startup). 0/1 flags stay integers
-- so rows read back in the shape the SQLite adapter returns. JSON blobs stay TEXT: they
-- round-trip byte-identically and nothing queries into them but one proposal field.
-- The code mirror (symbols, code_files, code_repos, the code vector pool) is not here.

CREATE EXTENSION IF NOT EXISTS vector;
-- BM25 full-text search (ParadeDB). Needs `pg_search` in shared_preload_libraries, which
-- the paradedb/paradedb image sets.
CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE TABLE nodes (
  id                 TEXT PRIMARY KEY,
  memory_kind        TEXT NOT NULL CHECK (memory_kind IN ('episodic', 'semantic', 'mirror')),
  type               TEXT NOT NULL,
  title              TEXT NOT NULL,
  project            TEXT,
  origin             TEXT,
  external_id        TEXT,
  synced_at          TEXT,
  valid_from         TEXT NOT NULL,
  invalidated_at     TEXT,
  consolidated_at    TEXT,
  pending_embedding  INTEGER NOT NULL DEFAULT 1,
  created_by_session TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  use_count          INTEGER NOT NULL DEFAULT 0,
  last_used_at       TEXT,
  event_from         TEXT,
  event_to           TEXT
);

CREATE INDEX idx_nodes_project ON nodes (project);
CREATE INDEX idx_nodes_kind_type ON nodes (memory_kind, type);
CREATE INDEX idx_nodes_pending ON nodes (pending_embedding) WHERE pending_embedding = 1;

CREATE TABLE revisions (
  node_id    TEXT NOT NULL REFERENCES nodes (id),
  rev        INTEGER NOT NULL,
  content    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reason     TEXT,
  ts         TEXT NOT NULL,
  PRIMARY KEY (node_id, rev)
);

-- What the text branch searches: the title and the current body, plus any generated
-- annotation terms. Rewritten on every revision and annotation.
CREATE TABLE node_text (
  node_id TEXT PRIMARY KEY REFERENCES nodes (id),
  title   TEXT NOT NULL,
  body    TEXT NOT NULL
);

CREATE INDEX node_text_bm25 ON node_text USING bm25 (
  node_id,
  (title::pdb.simple('stemmer=english')),
  (body::pdb.simple('stemmer=english'))
) WITH (key_field = 'node_id');

CREATE TABLE edges (
  src            TEXT NOT NULL REFERENCES nodes (id),
  dst            TEXT NOT NULL REFERENCES nodes (id),
  type           TEXT NOT NULL,
  provenance     TEXT NOT NULL,
  weight         DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  valid_from     TEXT NOT NULL,
  invalidated_at TEXT,
  session_id     TEXT NOT NULL,
  PRIMARY KEY (src, dst, type)
);

CREATE INDEX idx_edges_dst ON edges (dst);
CREATE INDEX edges_provenance_live ON edges (provenance, invalidated_at);

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  project        TEXT,
  started_at     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  client         TEXT,
  client_version TEXT,
  principal_id   TEXT
);

CREATE INDEX idx_sessions_principal ON sessions (principal_id, started_at);

CREATE TABLE principals (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  node_id    TEXT,
  detail     TEXT,
  ts         TEXT NOT NULL
);

CREATE INDEX idx_events_session ON events (session_id, ts);
CREATE INDEX idx_events_ts ON events (ts);

CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,
  node_id      TEXT NOT NULL REFERENCES nodes (id),
  rev          INTEGER NOT NULL,
  heading_path TEXT,
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  stale        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_chunks_node ON chunks (node_id, stale);
CREATE INDEX chunks_bm25 ON chunks USING bm25 (
  id,
  (text::pdb.simple('stemmer=english'))
) WITH (key_field = 'id');

-- One embedding model and dimension per space. Exactly one space is active; a model swap
-- is a new space filled beside the old one, then activated.
CREATE TABLE vector_spaces (
  id         SMALLINT PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX vector_spaces_one_active ON vector_spaces (active) WHERE active;

INSERT INTO vector_spaces (id, model, dim, created_at, active)
VALUES (1, 'Xenova/multilingual-e5-small', 384, '2026-09-27T00:00:00.000Z', TRUE);

-- A chunk's vector in one space. Its presence is what "embedded" means; there is no
-- separate provenance table. Searched exactly (no ANN index).
CREATE TABLE chunk_vectors (
  space_id      SMALLINT NOT NULL REFERENCES vector_spaces (id),
  chunk_id      TEXT NOT NULL REFERENCES chunks (id),
  embedding     VECTOR NOT NULL,
  model_version TEXT NOT NULL,
  ts            TEXT NOT NULL,
  PRIMARY KEY (space_id, chunk_id)
);

CREATE TABLE embedding_queue (
  node_id     TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE TABLE worker_lease (
  role       TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE consolidation_candidates (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  project      TEXT,
  member_ids   TEXT NOT NULL,
  member_hash  TEXT NOT NULL UNIQUE,
  canonical_id TEXT,
  score        DOUBLE PRECISION NOT NULL,
  proposal     TEXT,
  detected_at  TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,
  last_error   TEXT
);

CREATE INDEX idx_consolidation_status ON consolidation_candidates (status, kind);

CREATE TABLE revision_annotations (
  node_id     TEXT NOT NULL REFERENCES nodes (id),
  rev         INTEGER NOT NULL,
  annotations TEXT NOT NULL,
  ts          TEXT NOT NULL,
  PRIMARY KEY (node_id, rev)
);

CREATE TABLE consolidation_runs (
  id                   TEXT PRIMARY KEY,
  started_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  ended_at             TEXT,
  stage                TEXT NOT NULL,
  links_added          INTEGER NOT NULL DEFAULT 0,
  links_suggested      INTEGER NOT NULL DEFAULT 0,
  links_pruned         INTEGER NOT NULL DEFAULT 0,
  distilled            INTEGER NOT NULL DEFAULT 0,
  distill_suggested    INTEGER NOT NULL DEFAULT 0,
  merged               INTEGER NOT NULL DEFAULT 0,
  merge_suggested      INTEGER NOT NULL DEFAULT 0,
  pruned               INTEGER NOT NULL DEFAULT 0,
  prune_suggested      INTEGER NOT NULL DEFAULT 0,
  proposals_backfilled INTEGER NOT NULL DEFAULT 0,
  rejected             INTEGER NOT NULL DEFAULT 0,
  annotated            INTEGER NOT NULL DEFAULT 0,
  generation_failures  INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  merge_delayed        INTEGER NOT NULL DEFAULT 0,
  stage_ms             TEXT,
  wikilinks_linked     INTEGER NOT NULL DEFAULT 0,
  wikilinks_dangling   INTEGER NOT NULL DEFAULT 0,
  documents_suggested  INTEGER NOT NULL DEFAULT 0,
  documents_linked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX consolidation_runs_open ON consolidation_runs (started_at) WHERE ended_at IS NULL;

CREATE TABLE processes (
  id           TEXT PRIMARY KEY,
  role         TEXT NOT NULL,
  host         TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  node_version TEXT NOT NULL,
  db_path      TEXT NOT NULL,
  config_file  TEXT,
  config_state TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  model_state  TEXT,
  model_ms     INTEGER,
  model_error  TEXT,
  UNIQUE (host, pid)
);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  state            TEXT NOT NULL,
  scheduled_for    TEXT NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT,
  result_json      TEXT,
  last_error       TEXT,
  submitted_by     TEXT
);

CREATE INDEX jobs_claimable ON jobs (state, scheduled_for);
CREATE INDEX jobs_kind_state ON jobs (kind, state);

CREATE TABLE review_decisions (
  artifact_kind TEXT NOT NULL,
  artifact_ref  TEXT NOT NULL,
  decision      TEXT NOT NULL,
  decided_at    TEXT NOT NULL,
  decided_by    TEXT,
  note          TEXT,
  PRIMARY KEY (artifact_kind, artifact_ref)
);

CREATE INDEX review_decisions_at ON review_decisions (decided_at);

-- Authored edges into the code mirror, carried by the SQLite import until the code index
-- exists on this backend (Phase 5 re-links them by repo/path/qualified name).
CREATE TABLE code_refs (
  src         TEXT NOT NULL REFERENCES nodes (id),
  type        TEXT NOT NULL,
  repo        TEXT NOT NULL,
  path        TEXT NOT NULL,
  qualified   TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  symbol_live    INTEGER NOT NULL,
  valid_from     TEXT NOT NULL,
  invalidated_at TEXT,
  PRIMARY KEY (src, type, repo, qualified)
);
