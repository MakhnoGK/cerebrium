exports.up = function (db) {
  const existing = db.prepare("PRAGMA table_info(consolidation_candidates)").all();
  if (!existing.find((c) => c.name === "attempts")) {
    db.prepare(
      "ALTER TABLE consolidation_candidates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1",
    ).run();
  }
  if (!existing.find((c) => c.name === "last_error")) {
    db.prepare("ALTER TABLE consolidation_candidates ADD COLUMN last_error TEXT").run();
  }
};
