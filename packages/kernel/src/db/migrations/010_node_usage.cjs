// Per-node usage: how often a node was actually fetched, and when it was last fetched.
// Feeds two ranking terms — a bounded importance prior, and episodic decay measured from
// last use instead of wall-clock age. Node metadata, not a revision, so the append-only
// revisions invariant is untouched.
//
// A .cjs migration rather than plain SQL for two reasons: SQLite has no ADD COLUMN IF NOT
// EXISTS (and the legacy-upgrade path execs the current schema.sql first, so the columns
// may already exist), and the backfill has to parse JSON out of the events log.
//
// NOTE: ALTER TABLE appends these columns to nodes' stored CREATE TABLE text, so
// schema.sql must declare them last, in this order, or the drift guard fails.
exports.up = (db) => {
  const columns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('nodes')")
      .all()
      .map((c) => c.name),
  );

  if (!columns.has("use_count")) {
    db.prepare("ALTER TABLE nodes ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0").run();
  }

  if (!columns.has("last_used_at")) {
    db.prepare("ALTER TABLE nodes ADD COLUMN last_used_at TEXT").run();
  }

  // Backfill from the retrieval-outcome log: a `get` naming ids is the record of an agent
  // spending tokens on those nodes. Older rows logged only a count and carry no ids, so
  // they contribute nothing.
  const events = db
    .prepare("SELECT detail, ts FROM events WHERE action = 'get' AND detail LIKE '%\"ids\"%'")
    .all();
  const counts = new Map();

  for (const row of events) {
    let ids;

    try {
      ids = JSON.parse(row.detail).ids;
    } catch {
      continue;
    }

    if (!Array.isArray(ids)) continue;

    for (const id of ids) {
      if (typeof id !== "string") continue;

      const seen = counts.get(id);

      if (!seen) counts.set(id, { count: 1, last: row.ts });
      else {
        seen.count++;
        if (row.ts > seen.last) seen.last = row.ts;
      }
    }
  }

  const apply = db.prepare("UPDATE nodes SET use_count = ?, last_used_at = ? WHERE id = ?");

  for (const [id, seen] of counts) apply.run(seen.count, seen.last, id);
};
