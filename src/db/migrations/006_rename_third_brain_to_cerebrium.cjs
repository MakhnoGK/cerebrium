// One-time rename of this project's own indexed repo and authored memories from
// the pre-rename names ("third-brain", and the older "memory-kernel") to
// "cerebrium". Symbol identity is content-addressed on the repo name
// (external_id = sha256(repo \0 path \0 qualified \0 kind)), so the mirror can't be
// relabelled by a plain UPDATE — every symbol's external_id must be recomputed or
// the next incremental index would treat the whole repo as new. Idempotent and a
// no-op on any DB that never carried the old names.
const { createHash } = require("node:crypto");
const { resolve } = require("node:path");

const OLD_REPO = "third-brain";
const NEW = "cerebrium";
const NEW_ROOT = resolve(__dirname, "..", "..", "..");
const LEGACY_PROJECTS = ["third-brain", "memory-kernel"];

// Must match stableSymbolId in src/code/extract.ts exactly.
function stableSymbolId(repo, path, qualified, kind) {
  return createHash("sha256")
    .update(`${repo}\0${path}\0${qualified}\0${kind}`)
    .digest("hex")
    .slice(0, 24);
}

exports.up = (db) => {
  const symbols = db
    .prepare("SELECT node_id, path, qualified, symbol_kind AS kind FROM symbols WHERE repo = ?")
    .all(OLD_REPO);
  const setExt = db.prepare("UPDATE nodes SET external_id = ? WHERE id = ?");
  for (const s of symbols) setExt.run(stableSymbolId(NEW, s.path, s.qualified, s.kind), s.node_id);

  db.prepare(
    "UPDATE nodes SET project = ? WHERE project = ? AND type = 'symbol' AND origin = 'repo'",
  ).run(NEW, OLD_REPO);
  db.prepare("UPDATE symbols SET repo = ? WHERE repo = ?").run(NEW, OLD_REPO);
  db.prepare("UPDATE code_files SET repo = ? WHERE repo = ?").run(NEW, OLD_REPO);
  db.prepare("UPDATE code_repos SET repo = ?, root = ? WHERE repo = ?").run(
    NEW,
    NEW_ROOT,
    OLD_REPO,
  );

  // Authored (non-mirror) memories tagged with a legacy project name.
  const placeholders = LEGACY_PROJECTS.map(() => "?").join(",");
  db.prepare(
    `UPDATE nodes SET project = ? WHERE project IN (${placeholders}) AND NOT (type = 'symbol' AND origin = 'repo')`,
  ).run(NEW, ...LEGACY_PROJECTS);
};
