// Splits the single `chunk_vec` pool in two. `code_vec` takes the code-symbol index
// (`memory_kind='mirror' AND origin='repo'`); `chunk_vec` keeps authored memory and the
// curated external mirrors.
//
// Why it matters: on the author's store the pool was 127,011 rows, of which 125,735 were
// code symbols. `vectorSearch` runs the KNN first at k=200 and post-filters, so a search
// restricted to authored memory saw 18 of its 220 live nodes. The two curated-mirror
// sources (63 rows) sit with authored memory rather than with code precisely because they
// would otherwise stay buried in the big pool forever.
//
// A .cjs migration rather than plain SQL because vec0 has no INSERT..SELECT: each vector
// is read, re-inserted into the new table, and deleted from the old one. Batched so the
// whole 126k-row pool is never resident at once; the loop terminates because every batch
// deletes what it moved, which also makes a re-run a no-op.
exports.up = (db) => {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS code_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[384] distance_metric=cosine
);`);

  const batch = db.prepare(
    `SELECT cv.chunk_id AS id, cv.embedding AS embedding
       FROM chunk_vec cv
       JOIN chunks c ON c.id = cv.chunk_id
       JOIN nodes n ON n.id = c.node_id
      WHERE n.memory_kind = 'mirror' AND n.origin = 'repo'
      LIMIT 2000`,
  );
  const insert = db.prepare("INSERT OR REPLACE INTO code_vec (chunk_id, embedding) VALUES (?, ?)");
  const remove = db.prepare("DELETE FROM chunk_vec WHERE chunk_id = ?");

  for (;;) {
    const rows = batch.all();

    if (!rows.length) break;

    for (const row of rows) {
      insert.run(row.id, row.embedding);
      remove.run(row.id);
    }
  }
};
