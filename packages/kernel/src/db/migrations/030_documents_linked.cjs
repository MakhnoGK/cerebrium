exports.up = function (db) {
  const existing = db.prepare("PRAGMA table_info(consolidation_runs)").all();
  if (!existing.find((c) => c.name === "documents_linked")) {
    db.prepare(
      "ALTER TABLE consolidation_runs ADD COLUMN documents_linked INTEGER NOT NULL DEFAULT 0",
    ).run();
  }
};
