exports.up = function (db) {
  const existing = db.prepare("PRAGMA table_info(consolidation_runs)").all();
  if (!existing.find((c) => c.name === "stage_ms")) {
    db.prepare("ALTER TABLE consolidation_runs ADD COLUMN stage_ms TEXT").run();
  }
};
