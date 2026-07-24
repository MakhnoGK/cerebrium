-- Phase 5 — consolidation. One operational queue table for the daemon's consolidation
-- sweep. Detection (deterministic: episodic clustering, similar_to kNN, dup detection,
-- dead-mirror scan) writes `consolidation_candidates` rows; a candidate is then either
-- applied autonomously (auto posture) or reviewed by an agent via the consolidate_suggest/
-- consolidate_apply tools (suggest posture). `member_hash` (sha256 of kind + sorted member
-- ids) is UNIQUE so re-detecting the same cluster is a no-op regardless of its status —
-- a dismissed or applied cluster is never re-proposed. `proposal` holds a pre-generated
-- {title,summary,body} when a generation provider ran; NULL when the agent will author it.
-- Resolving a candidate updates status/resolved_* in place — this is a queue row, not a
-- `revisions`/content row, so the append-only invariant does not apply (cf. embedding_queue).
-- Idempotent (IF NOT EXISTS); mirrors schema.sql.

CREATE TABLE IF NOT EXISTS consolidation_candidates (
  id            TEXT PRIMARY KEY,                -- ULID
  kind          TEXT NOT NULL,                   -- 'distill'|'merge'|'link'|'prune'
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'applied'|'dismissed'
  project       TEXT,                            -- scope carried onto any node the apply writes
  member_ids    TEXT NOT NULL,                   -- JSON array of the cluster's node ids
  member_hash   TEXT NOT NULL,                   -- sha256(kind \0 sorted member ids) — idempotency key
  canonical_id  TEXT,                            -- merge: survivor; link: dst; else NULL
  score         REAL NOT NULL,                   -- detection confidence (similarity)
  proposal      TEXT,                            -- JSON {title,summary,body} if pre-generated, else NULL
  detected_at   TEXT NOT NULL,
  resolved_at   TEXT,                            -- set when status leaves 'pending'
  resolved_by   TEXT,                            -- session id, or 'daemon:auto'
  UNIQUE (member_hash)
);
CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_candidates(status, kind);
