// The event axis: when a fact was true in the world, as opposed to when this store learned
// it. The ingestion axis already existed (created_at / invalidated_at / revisions.ts), which
// is why `as_of` needed no migration; this is the other half. Kept as its own pair rather
// than repurposing `valid_from`, which means ingestion time despite its name and is what
// episodic decay measures age from — redefining it would silently re-rank 125k nodes.
//
// Deliberately NOT backfilled. Setting event_from = valid_from would assert something
// unknown: "we recorded this on D" is not "this became true on D". NULL means no claim is
// made about validity, and reads treat it as an open interval.
//
// A .cjs migration for the same reason as 010: SQLite has no ADD COLUMN IF NOT EXISTS, and
// the legacy-upgrade path execs the current schema.sql (where these columns already exist)
// before applying the numbered migrations.
//
// NOTE: ALTER TABLE appends these to nodes' stored CREATE TABLE text, so schema.sql must
// declare them last, in this order, or the drift guard fails.
exports.up = (db) => {
  const columns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('nodes')")
      .all()
      .map((c) => c.name),
  );

  if (!columns.has("event_from")) {
    db.prepare("ALTER TABLE nodes ADD COLUMN event_from TEXT").run();
  }

  if (!columns.has("event_to")) {
    db.prepare("ALTER TABLE nodes ADD COLUMN event_to TEXT").run();
  }
};
