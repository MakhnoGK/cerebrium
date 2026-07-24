-- Phase 3a — external mirrors. Two operational tables for agent-driven mirroring of the
-- external tools the agent already has MCP access to (GitLab/Jira/Confluence/Notion/Sentry/
-- Grafana/Slack/Testrail/Tableau/Amplitude). `mirror_sources` is the per-deployment source
-- registry (catalog + freshness state), empty in a fresh clone; `mirror_records` holds the
-- per-record back-reference (source + native id) plus a deep-link URL and opaque facet JSON
-- for `mirror` nodes whose origin != 'repo'. External mirror nodes are ordinary `nodes` rows
-- (memory_kind='mirror', origin=<source kind>, external_id=sha256(source_id\0native_id)) — the
-- `nodes` table is NOT altered (its origin/external_id/synced_at columns were reserved for
-- this). The node's revision content is the agent-composed summary (FTS + embedded); url and
-- facets live here and are returned only via `get`. A mirror node's `type` is open vocab (no
-- CHECK), so a new source needs no migration. Idempotent (IF NOT EXISTS); mirrors schema.sql.

CREATE TABLE IF NOT EXISTS mirror_sources (
  id              TEXT PRIMARY KEY,   -- instance id, e.g. 'grafana-prod', 'sentry', 'gitlab'
  kind            TEXT NOT NULL,      -- source kind → becomes each node's `origin`, e.g. 'grafana'
  label           TEXT,               -- human label, e.g. 'Grafana (prod)'
  project         TEXT,               -- default `project` scope for this source's mirror nodes
  freshness_hours INTEGER,            -- staleness threshold; NULL = never reported stale
  recipe          TEXT,               -- pointer to the docs/mirrors/*.md recipe (informational)
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_synced_at  TEXT,               -- stamped by mirror_upsert; NULL = never synced
  registered_at   TEXT NOT NULL,
  invalidated_at  TEXT                -- soft-delete a retired source (never hard-deleted)
);
CREATE INDEX IF NOT EXISTS idx_mirror_sources_kind ON mirror_sources(kind);

CREATE TABLE IF NOT EXISTS mirror_records (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id),
  source_id  TEXT NOT NULL,          -- the mirror_sources.id this record came from
  native_id  TEXT NOT NULL,          -- the source's own id (issue key, message ts, chart id)
  url        TEXT,                   -- deep link back to the source record
  facets     TEXT,                   -- opaque agent-supplied JSON (status/author/labels/...)
  UNIQUE (source_id, native_id)
);
CREATE INDEX IF NOT EXISTS idx_mirror_records_source ON mirror_records(source_id);
