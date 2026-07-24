-- Write-time attribute enrichment (MemInsight-style). A per-revision annotation the
-- daemon's ConsolidationWorker generates for a semantic node — LLM-mined keywords, tags,
-- and a short contextual description — folded into the node's FTS text so it is findable
-- by a wider set of phrasings. Keyed by (node_id, rev): an annotation belongs to one
-- revision, so a later `update` (new rev) leaves the old row behind and the node is
-- re-detected as un-annotated and re-enriched. This is a derived side-table, NOT a
-- `revisions` row — the append-only-revisions invariant is untouched (the row is written
-- once per rev and never mutated). `annotations` is a JSON {keywords[], tags[], context}.
-- Idempotent (IF NOT EXISTS); mirrors schema.sql.

CREATE TABLE IF NOT EXISTS revision_annotations (
  node_id     TEXT NOT NULL REFERENCES nodes(id),
  rev         INTEGER NOT NULL,             -- the revision this annotation describes
  annotations TEXT NOT NULL,                -- JSON {keywords:[], tags:[], context:""}
  ts          TEXT NOT NULL,
  PRIMARY KEY (node_id, rev)
);
