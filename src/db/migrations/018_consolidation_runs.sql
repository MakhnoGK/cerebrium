-- Operational queue row like embedding_queue (in-place UPDATE is fine, invariants #2/#3 govern revisions/content)
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
  last_error TEXT
) STRICT;
