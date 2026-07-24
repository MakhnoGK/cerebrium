-- Phase 2 — retrieval quality. Adds chunk text + vector storage and the async
-- embedding queue. Idempotent (IF NOT EXISTS); mirrors the end state in schema.sql.
-- The `chunk_vec` vec0 table requires the sqlite-vec extension, loaded in
-- db/database.ts before this runs. No existing Phase 1 table is altered — the
-- `pending_embedding` column already exists and is now consumed by the worker.

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  node_id      TEXT NOT NULL REFERENCES nodes(id),
  rev          INTEGER NOT NULL,
  heading_path TEXT,
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  stale        INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
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
  node_id     TEXT PRIMARY KEY,
  enqueued_at TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_node ON chunks(node_id, stale);
