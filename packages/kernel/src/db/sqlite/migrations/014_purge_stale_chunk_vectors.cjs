// Clears the vectors left behind by every chunk an earlier revision dropped. `syncChunks`
// has always marked a superseded chunk `stale = 1` and left its vector in place, so the
// pool accumulated rows no query can ever return — 429 of the 1,213 authored rows on the
// author's store, a third of the small pool.
//
// This deletes derived data only: the `chunks` row stays exactly as it was, and the text
// it holds is all that is needed to recompute the vector. `embedding_meta` goes with it so
// a revived chunk (ids are content-addressed) re-enqueues rather than reading as embedded.
exports.up = (db) => {
  const stale = db
    .prepare("SELECT id FROM chunks WHERE stale = 1")
    .all()
    .map((r) => r.id);

  const statements = [
    db.prepare("DELETE FROM chunk_vec WHERE chunk_id = ?"),
    db.prepare("DELETE FROM code_vec WHERE chunk_id = ?"),
    db.prepare("DELETE FROM embedding_meta WHERE chunk_id = ?"),
  ];

  for (const id of stale) {
    for (const statement of statements) statement.run(id);
  }
};
