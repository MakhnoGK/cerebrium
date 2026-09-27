exports.up = (db) => {
  const ts = new Date().toISOString();
  const session = "migration:016_repair_post_supersede_edges";

  const state = db.prepare("SELECT invalidated_at FROM nodes WHERE id = ?");
  const successors = db.prepare(
    `SELECT src FROM edges
     WHERE dst = ? AND type = 'supersedes' AND invalidated_at IS NULL
     ORDER BY valid_from DESC, src ASC`,
  );

  const terminalSuccessor = (id) => {
    const live = new Set();
    const visited = new Set();
    const pending = [id];

    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);

      for (const row of successors.all(current)) {
        const node = state.get(row.src);
        if (!node) continue;
        if (node.invalidated_at === null) live.add(row.src);
        else if (!visited.has(row.src)) pending.push(row.src);
      }
    }

    return live.size === 1 ? [...live][0] : null;
  };

  const stranded = db
    .prepare(
      `SELECT e.src AS src, e.dst AS dead, e.type AS type, e.weight AS weight
       FROM edges e
       JOIN nodes ns ON ns.id = e.src
       JOIN nodes nd ON nd.id = e.dst
       WHERE e.invalidated_at IS NULL AND e.provenance = 'agent'
         AND e.type <> 'supersedes'
         AND ns.memory_kind IN ('semantic', 'episodic') AND ns.invalidated_at IS NULL
         AND nd.memory_kind IN ('semantic', 'episodic') AND nd.invalidated_at IS NOT NULL`,
    )
    .all();

  const retire = db.prepare(
    `UPDATE edges SET invalidated_at = ?
     WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL`,
  );
  const existing = db.prepare(
    "SELECT invalidated_at FROM edges WHERE src = ? AND dst = ? AND type = ?",
  );
  const reattach = db.prepare(
    `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
     VALUES (?, ?, ?, 'agent', ?, ?, ?)
     ON CONFLICT(src, dst, type) DO UPDATE SET
       invalidated_at = NULL, valid_from = excluded.valid_from,
       weight = excluded.weight, provenance = excluded.provenance`,
  );

  for (const edge of stranded) {
    const successor = terminalSuccessor(edge.dead);
    if (!successor) continue;

    retire.run(ts, edge.src, edge.dead, edge.type);
    if (edge.src === successor) continue;

    const collision = existing.get(edge.src, successor, edge.type);
    if (collision?.invalidated_at === null) continue;

    reattach.run(edge.src, successor, edge.type, edge.weight, ts, session);
  }
};
