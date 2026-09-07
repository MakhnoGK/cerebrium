-- What an operator decided about a write that landed under a `suggest` posture.
--
-- Operational state like `jobs`: one row per artifact, updated in place, nothing versioned
-- and nothing soft-deleted.
--
-- Keyed on the artifact rather than on the audit row that recorded it. The `events` row for
-- a `link` names no edge — it carries `{"review":true}` and a null `node_id` — so the audit
-- cannot say what there is to review. The artifact itself can: an edge carries the session
-- that authored it, and a session carries its principal.
CREATE TABLE IF NOT EXISTS review_decisions (
  -- 'edge' | 'node'
  artifact_kind TEXT NOT NULL,
  -- A node id, or `src|dst|type` for an edge.
  artifact_ref TEXT NOT NULL,
  -- 'kept' | 'undone'
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  -- The principal that decided, which is never the one that wrote: reviewing costs the
  -- `consolidate` capability, and a writing agent's profile does not carry it.
  decided_by TEXT,
  note TEXT,
  PRIMARY KEY (artifact_kind, artifact_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS review_decisions_at ON review_decisions (decided_at);

-- The review queue counts live agent edges on every hint, and `edges` carries no index on
-- provenance — without this that is a full scan of every code edge the mirror ever drew.
CREATE INDEX IF NOT EXISTS edges_provenance_live ON edges (provenance, invalidated_at);
