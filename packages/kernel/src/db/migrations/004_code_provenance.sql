-- Per-repo indexing provenance: which git branch/commit the current index reflects,
-- and whether the working tree was dirty at index time. Informational only — never a
-- query key (symbols stay keyed by repo/path/qualified, branch-agnostic). One row per
-- repo, rewritten on every index run (so it stays accurate despite the per-file
-- hash-gate, which skips unchanged files). Idempotent; mirrors schema.sql.
CREATE TABLE IF NOT EXISTS code_repos (
  repo       TEXT PRIMARY KEY,
  branch     TEXT,
  commit_sha TEXT,
  dirty      INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);
