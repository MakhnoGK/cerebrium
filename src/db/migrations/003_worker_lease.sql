-- Single-writer election for the async embedding drain. One stdio server process
-- per Claude Code session opens the shared DB; this lease keeps exactly one of
-- their in-process workers draining the queue at a time. Internal process
-- coordination only — not the agent-facing advisory-lease feature.
CREATE TABLE IF NOT EXISTS worker_lease (
  role       TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
