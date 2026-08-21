exports.up = function (db) {
  const existing = db.prepare("PRAGMA table_info(consolidation_runs)").all();
  for (const column of ["wikilinks_linked", "wikilinks_dangling"]) {
    if (!existing.find((c) => c.name === column)) {
      db.prepare(
        `ALTER TABLE consolidation_runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      ).run();
    }
  }
};
