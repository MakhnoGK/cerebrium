-- Which machine a process runs on: a pid is only meaningful on its own host. Recreated
-- rather than altered, because SQLite cannot drop UNIQUE(pid) in place. The registry is
-- operational state that every process republishes when it starts.
DROP TABLE IF EXISTS processes;

CREATE TABLE processes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  host TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  node_version TEXT NOT NULL,
  db_path TEXT NOT NULL,
  config_file TEXT,
  config_state TEXT NOT NULL,
  config_json TEXT NOT NULL,
  model_state TEXT,
  model_ms INTEGER,
  model_error TEXT,
  UNIQUE (host, pid)
) STRICT;
