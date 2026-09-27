-- Add `root` (absolute repo path) to code_repos so a repo can be re-indexed by name
-- even when MEMORY_CODE_ROOTS doesn't define it — the first index-by-path remembers
-- where the repo lives. Recreated rather than ALTER-ed: SQLite has no ADD COLUMN IF
-- NOT EXISTS, and schema.sql already creates code_repos at its end-state shape (with
-- root), so a plain ALTER would fail on a fresh DB. code_repos is operational metadata
-- regenerated on the next index run, so dropping it loses nothing durable.
DROP TABLE IF EXISTS code_repos;
CREATE TABLE code_repos (
  repo       TEXT PRIMARY KEY,
  root       TEXT,
  branch     TEXT,
  commit_sha TEXT,
  dirty      INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);
