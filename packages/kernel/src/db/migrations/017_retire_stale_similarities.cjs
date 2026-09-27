exports.up = (db) => {
  const ts = new Date().toISOString();

  db.prepare(
    `UPDATE edges SET invalidated_at = @ts
     WHERE invalidated_at IS NULL AND type = 'similar_to' AND provenance = 'system'
       AND (
         EXISTS (SELECT 1 FROM nodes WHERE id = edges.src AND invalidated_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM nodes WHERE id = edges.dst AND invalidated_at IS NOT NULL)
       )`,
  ).run({ ts });
};
