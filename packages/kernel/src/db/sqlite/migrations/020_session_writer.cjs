exports.up = function (db) {
  const existing = db.prepare("PRAGMA table_info(sessions)").all();
  if (!existing.find((c) => c.name === "client")) {
    db.prepare("ALTER TABLE sessions ADD COLUMN client TEXT").run();
  }
  if (!existing.find((c) => c.name === "client_version")) {
    db.prepare("ALTER TABLE sessions ADD COLUMN client_version TEXT").run();
  }
};
