// Third-party code that was indexed before `vendor` and `_ide_helper` were excluded from
// the walk. Retired rather than deleted: the rows stay, so the same predicate reverses it.
// Edges are retired alongside, or every one of them becomes a dangling edge in `stats`.
exports.up = (db) => {
  const ts = new Date().toISOString();
  const predicate = `
    sy.path LIKE '%vendor/%'
    OR sy.path LIKE 'vendor/%'
    OR sy.path LIKE '%node_modules/%'
    OR sy.path LIKE '%_ide_helper%'`;

  const targets = db
    .prepare(`SELECT sy.node_id AS id FROM symbols sy WHERE ${predicate}`)
    .all()
    .map((r) => r.id);

  if (!targets.length) return;

  const chunk = 400;

  for (let i = 0; i < targets.length; i += chunk) {
    const slice = targets.slice(i, i + chunk);
    const holes = slice.map(() => "?").join(",");

    db.prepare(
      `UPDATE edges SET invalidated_at = ?
       WHERE invalidated_at IS NULL AND (src IN (${holes}) OR dst IN (${holes}))`,
    ).run(ts, ...slice, ...slice);

    db.prepare(
      `UPDATE nodes SET invalidated_at = ?
       WHERE invalidated_at IS NULL AND memory_kind = 'mirror' AND id IN (${holes})`,
    ).run(ts, ...slice);
  }

  // A file that is no longer walked must not look indexed, or a later run of a repo that
  // still exists would hash-gate it and never notice.
  db.prepare(
    `DELETE FROM code_files
     WHERE path LIKE '%vendor/%' OR path LIKE 'vendor/%'
        OR path LIKE '%node_modules/%' OR path LIKE '%_ide_helper%'`,
  ).run();
};
