-- One row per live Cerebrium process, so a deployment's effective configuration is
-- readable instead of guessable. Operational state, not memory content: rows are
-- replaced and deleted in place, and nothing here is versioned.
CREATE TABLE IF NOT EXISTS processes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  pid INTEGER NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  node_version TEXT NOT NULL,
  db_path TEXT NOT NULL,
  config_file TEXT,
  config_state TEXT NOT NULL,
  config_json TEXT NOT NULL
) STRICT;
