import type { EnrichedRow, NeighborStub } from "@cerebrium/contracts/types";
import { EdgeType } from "@cerebrium/contracts/vocab";
import type { PgDatabase } from "@/db/postgres/database";
import { chunkContent } from "@/core/chunk";

// The Postgres counterparts of db/sqlite/internal.ts. Every helper is async and runs on
// whatever the caller is in: inside a `tx` it joins that transaction through the ALS-held
// client, outside one it is a single autocommit statement.

export const MAX_EMBED_ATTEMPTS = 5;

export const LATEST_REVISION = `
  JOIN revisions lr ON lr.node_id = n.id
    AND lr.rev = (SELECT MAX(r.rev) FROM revisions r WHERE r.node_id = n.id)
`;

export const ENRICHED = `
  SELECT n.id, n.memory_kind, n.type, n.title, n.project, n.valid_from, n.invalidated_at,
         lr.rev AS rev, lr.ts AS updated, lr.content AS content,
         (SELECT COUNT(*) FROM edges e
            WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edge_count,
         n.use_count, n.last_used_at
  FROM nodes n
  ${LATEST_REVISION}
`;

export const ACTIVE_SPACE = "(SELECT id FROM vector_spaces WHERE active)";

// pgvector's text form, which is also a JSON array.
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export function parseVector(raw: string): Float32Array {
  return Float32Array.from(JSON.parse(raw) as number[]);
}

export async function enrichedById(db: PgDatabase, id: string): Promise<EnrichedRow | undefined> {
  return (await db.query<EnrichedRow>(`${ENRICHED} WHERE n.id = @id`, { id })).rows[0];
}

export async function enrichedByIds(db: PgDatabase, ids: string[]): Promise<EnrichedRow[]> {
  if (!ids.length) return [];

  return (await db.query<EnrichedRow>(`${ENRICHED} WHERE n.id = ANY(@ids)`, { ids })).rows;
}

export async function insertRevision(
  db: PgDatabase,
  id: string,
  rev: number,
  content: string,
  session_id: string,
  reason: string | null,
  ts: string,
): Promise<void> {
  await db.query(
    `INSERT INTO revisions (node_id, rev, content, session_id, reason, ts)
     VALUES (@id, @rev, @content, @session_id, @reason, @ts)`,
    { id, rev, content, session_id, reason, ts },
  );
}

export async function textPut(
  db: PgDatabase,
  id: string,
  title: string,
  body: string,
): Promise<void> {
  await db.query(
    `INSERT INTO node_text (node_id, title, body) VALUES (@id, @title, @body)
     ON CONFLICT (node_id) DO UPDATE SET title = excluded.title, body = excluded.body`,
    { id, title, body },
  );
}

export async function countUnembedded(db: PgDatabase, nodeId: string): Promise<number> {
  const row = (
    await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM chunks c
       WHERE c.node_id = @nodeId AND c.stale = 0
         AND NOT EXISTS (
           SELECT 1 FROM chunk_vectors v WHERE v.space_id = ${ACTIVE_SPACE} AND v.chunk_id = c.id
         )`,
      { nodeId },
    )
  ).rows[0];

  return row?.c ?? 0;
}

export async function refreshQueue(db: PgDatabase, nodeId: string, ts: string): Promise<void> {
  if ((await countUnembedded(db, nodeId)) > 0) {
    await db.query(
      `INSERT INTO embedding_queue (node_id, enqueued_at, attempts, last_error)
       VALUES (@nodeId, @ts, 0, NULL)
       ON CONFLICT (node_id) DO UPDATE SET
         enqueued_at = excluded.enqueued_at, attempts = 0, last_error = NULL`,
      { nodeId, ts },
    );
    await db.query("UPDATE nodes SET pending_embedding = 1 WHERE id = @nodeId", { nodeId });
  } else {
    await db.query("DELETE FROM embedding_queue WHERE node_id = @nodeId", { nodeId });
    await db.query("UPDATE nodes SET pending_embedding = 0 WHERE id = @nodeId", { nodeId });
  }
}

// Diff the node's current chunk set against what's stored: unchanged ids keep their
// vectors, dropped ids go stale, and the node is (re)queued only if some current chunk
// still lacks an embedding.
export async function syncChunks(
  db: PgDatabase,
  nodeId: string,
  rev: number,
  content: string,
  ts: string,
): Promise<void> {
  const chunks = chunkContent(nodeId, content);
  const newIds = new Set(chunks.map((c) => c.id));
  const existing = (
    await db.query<{ id: string }>("SELECT id FROM chunks WHERE node_id = @nodeId", { nodeId })
  ).rows;

  for (const c of chunks) {
    await db.query(
      `INSERT INTO chunks (id, node_id, rev, heading_path, seq, text, stale)
       VALUES (@id, @node_id, @rev, @heading_path, @seq, @text, 0)
       ON CONFLICT (id) DO UPDATE SET
         rev = excluded.rev, seq = excluded.seq, heading_path = excluded.heading_path, stale = 0`,
      {
        id: c.id,
        node_id: nodeId,
        rev,
        heading_path: c.heading_path,
        seq: c.seq,
        text: c.text,
      },
    );
  }

  for (const row of existing) {
    if (newIds.has(row.id)) continue;

    await db.query("UPDATE chunks SET stale = 1 WHERE id = @id", { id: row.id });
    await dropVector(db, row.id);
  }

  await refreshQueue(db, nodeId, ts);
}

// Drops a chunk's derived vectors, in every space; the chunk row itself is only ever
// soft-deleted. A revived chunk then re-enqueues.
export async function dropVector(db: PgDatabase, chunkId: string): Promise<void> {
  await db.query("DELETE FROM chunk_vectors WHERE chunk_id = @chunkId", { chunkId });
}

// Revive a previously-invalidated edge of the same (src,dst,type); otherwise insert.
export async function insertEdge(
  db: PgDatabase,
  src: string,
  dst: string,
  type: EdgeType,
  provenance: "agent" | "system",
  session_id: string,
  ts: string,
  weight = 1.0,
): Promise<void> {
  await db.query(
    `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
     VALUES (@src, @dst, @type, @provenance, @weight, @ts, @session_id)
     ON CONFLICT (src, dst, type) DO UPDATE SET
       invalidated_at = NULL, valid_from = excluded.valid_from,
       weight = excluded.weight, provenance = excluded.provenance`,
    { src, dst, type, provenance, weight, ts, session_id },
  );
}

export async function invalidateEdge(
  db: PgDatabase,
  src: string,
  dst: string,
  type: EdgeType,
  ts: string,
): Promise<void> {
  await db.query(
    `UPDATE edges SET invalidated_at = @ts
     WHERE src = @src AND dst = @dst AND type = @type AND invalidated_at IS NULL`,
    { ts, src, dst, type },
  );
}

export async function invalidateSystemSimilaritiesOf(
  db: PgDatabase,
  id: string,
  ts: string,
): Promise<number> {
  return (
    (
      await db.query(
        `UPDATE edges SET invalidated_at = @ts
         WHERE invalidated_at IS NULL AND type = @type AND provenance = 'system'
           AND (src = @id OR dst = @id)`,
        { id, ts, type: EdgeType.SIMILAR_TO },
      )
    ).rowCount ?? 0
  );
}

export async function edgesOf(db: PgDatabase, id: string): Promise<NeighborStub[]> {
  const out = (
    await db.query<{ edge: string; id: string; type: string; title: string }>(
      `SELECT e.type AS edge, n.id, n.type, n.title FROM edges e
       JOIN nodes n ON n.id = e.dst WHERE e.src = @id AND e.invalidated_at IS NULL
       ORDER BY e.dst, e.type`,
      { id },
    )
  ).rows;
  const inc = (
    await db.query<{ edge: string; id: string; type: string; title: string }>(
      `SELECT e.type AS edge, n.id, n.type, n.title FROM edges e
       JOIN nodes n ON n.id = e.src WHERE e.dst = @id AND e.invalidated_at IS NULL
       ORDER BY e.src, e.type`,
      { id },
    )
  ).rows;

  return [
    ...out.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      edge: r.edge,
      direction: "out" as const,
    })),
    ...inc.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      edge: r.edge,
      direction: "in" as const,
    })),
  ];
}
