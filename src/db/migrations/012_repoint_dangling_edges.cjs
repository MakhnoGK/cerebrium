// One-shot repair of the backlog that accumulated while `invalidateNode` left inbound
// edges pointing at the node it retired. Re-points each stranded referrer onto the
// successor, exactly as the write path now does going forward.
//
// A .cjs migration rather than plain SQL because picking one successor per dead node is a
// per-row choice SQLite's UPDATE...FROM cannot express, and because it must replicate
// EdgesRepo.insertEdge's revive-on-conflict upsert rather than fail on the (src,dst,type)
// primary key.
//
// Scope, and why it is narrower than the raw dangling count suggests. Of the 533 live
// edges on the author's store that point at a soft-deleted node: 96 are `supersedes` edges,
// for which that is the entire point; 411 are system `similar_to` edges the consolidation
// sweep recomputes from vectors, so re-pointing one would assert a similarity nobody
// measured. The remaining 26 authored anchors are what this repairs.
//
// Nothing is deleted: the old edge is soft-invalidated and stays visible with
// `history:true`, so the record of what was referenced at write time survives. Chains
// (A superseded by B, B by C) resolve only one hop, which was measured to lose nothing —
// every repairable edge on that store had a live direct successor.
exports.up = (db) => {
  const ts = new Date().toISOString();
  const session = "migration:012_repoint_dangling_edges";

  // Among several live successors, the most recently recorded one wins; `src` breaks a
  // tie so the choice is stable across runs and machines.
  const stranded = db
    .prepare(
      `SELECT e.src AS src, e.dst AS dead, e.type AS type, e.weight AS weight,
              (SELECT s.src FROM edges s JOIN nodes sn ON sn.id = s.src
                WHERE s.dst = e.dst AND s.type = 'supersedes' AND s.invalidated_at IS NULL
                  AND sn.invalidated_at IS NULL
                ORDER BY s.valid_from DESC, s.src DESC LIMIT 1) AS successor
         FROM nodes nd
         JOIN edges e ON e.dst = nd.id
         JOIN nodes ns ON ns.id = e.src
        WHERE nd.memory_kind IN ('semantic', 'episodic') AND nd.invalidated_at IS NOT NULL
          AND e.invalidated_at IS NULL AND e.type <> 'supersedes' AND e.provenance = 'agent'
          AND ns.memory_kind IN ('semantic', 'episodic') AND ns.invalidated_at IS NULL`,
    )
    .all()
    .filter((r) => r.successor);

  const retire = db.prepare(
    `UPDATE edges SET invalidated_at = ?
      WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL`,
  );
  const reattach = db.prepare(
    `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
     VALUES (?, ?, ?, 'agent', ?, ?, ?)
     ON CONFLICT(src, dst, type) DO UPDATE SET
       invalidated_at = NULL, valid_from = excluded.valid_from,
       weight = excluded.weight, provenance = excluded.provenance`,
  );

  for (const r of stranded) {
    retire.run(ts, r.src, r.dead, r.type);
    if (r.src === r.successor) continue; // self-loop after re-point -> drop
    reattach.run(r.src, r.successor, r.type, r.weight, ts, session);
  }
};
