-- The work queue. Operational state like `embedding_queue` and `consolidation_runs`:
-- rows are updated in place and nothing here is versioned or soft-deleted.
--
-- One row per attempted unit of work, whatever the consumer. `kind` is namespaced
-- (`code.*` is kernel work the daemon runs in-process; `agent.*` is reserved for a host
-- that spawns something external) and a consumer claims only the prefixes it declares,
-- which is what keeps process-spawning out of the kernel without a column saying so.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  -- pending | running | done | failed | cancelled
  state TEXT NOT NULL,
  -- Not claimable before this instant. A job submitted for "now" carries the submit time.
  scheduled_for TEXT NOT NULL,
  -- Per-row lease, same discipline as `worker_lease` but scoped to one job: a consumer
  -- that dies leaves a `running` row whose lease expires, and the next one reclaims it.
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  result_json TEXT,
  last_error TEXT,
  -- The principal that submitted it; null for the scheduler's own maintenance work.
  submitted_by TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (state, scheduled_for);
CREATE INDEX IF NOT EXISTS jobs_kind_state ON jobs (kind, state);
