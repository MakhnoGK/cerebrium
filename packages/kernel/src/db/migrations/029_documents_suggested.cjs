exports.up = function (db) {
  const existing = db.prepare("PRAGMA table_info(consolidation_runs)").all();
  if (!existing.find((c) => c.name === "documents_suggested")) {
    db.prepare(
      "ALTER TABLE consolidation_runs ADD COLUMN documents_suggested INTEGER NOT NULL DEFAULT 0",
    ).run();
  }
};
