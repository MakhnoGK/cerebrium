// A principal is the writer behind a session, stable across sessions — the thing a
// capability profile, a quota and a trust weight can be attached to. Keyed by the client
// name the MCP handshake reports, the way `mirror_sources` is keyed by its source name:
// policy is written and read by that name, so a surrogate id would only add a join.
exports.up = function (db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS principals (
       id         TEXT PRIMARY KEY,
       kind       TEXT NOT NULL,
       label      TEXT,
       created_at TEXT NOT NULL,
       last_seen  TEXT NOT NULL
     ) STRICT`,
  ).run();

  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  if (!columns.find((c) => c.name === "principal_id")) {
    db.prepare("ALTER TABLE sessions ADD COLUMN principal_id TEXT").run();
  }
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_sessions_principal ON sessions(principal_id, started_at)",
  ).run();

  // Sessions written before writer identity existed join to one named principal rather
  // than to nothing: per-principal policy has to be able to address them, and silence
  // would leave the majority of an existing store outside every rule.
  const UNATTRIBUTED = "(unattributed)";

  const groups = db
    .prepare(
      `SELECT COALESCE(client, ?) AS id, MIN(started_at) AS first_seen, MAX(started_at) AS last_seen
         FROM sessions GROUP BY COALESCE(client, ?)`,
    )
    .all(UNATTRIBUTED, UNATTRIBUTED);

  const insert = db.prepare(
    `INSERT INTO principals (id, kind, label, created_at, last_seen)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen = MAX(principals.last_seen, excluded.last_seen)`,
  );
  const attach = db.prepare(
    "UPDATE sessions SET principal_id = ? WHERE COALESCE(client, ?) = ? AND principal_id IS NULL",
  );

  for (const group of groups) {
    insert.run(group.id, kindOf(group.id, UNATTRIBUTED), group.first_seen, group.last_seen);
    attach.run(group.id, UNATTRIBUTED, group.id);
  }
};

function kindOf(id, unattributed) {
  if (id === unattributed) return "unattributed";

  return id.startsWith("cerebrium-") ? "system" : "agent";
}
