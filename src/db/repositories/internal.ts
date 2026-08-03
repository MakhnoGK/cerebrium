import type Database from "better-sqlite3";
import { MAX_EMBED_ATTEMPTS } from "@/db/repositories/base";
import { chunkContent } from "@/core/chunk";
import type { EnrichedRow } from "@/core/types";
import { CODE_ORIGIN, MemoryKind } from "@/core/vocab";

// Cross-aggregate primitives shared by the node-write path (NodesRepo), the code
// mirror (CodeRepo), and the embedding drain (EmbeddingQueueRepo). They keep the SQL
// explicit and in one place so the FTS-in-write-transaction and chunk/queue
// invariants read identically wherever a node's content changes. Callers invoke
// them inside their own transaction.

// Joins `n` to its current revision as `lr`. The correlated MAX is the point: grouping
// `revisions` first materializes the latest rev of every node in the store, so a query
// that wanted twenty of them still scanned all 127k rows. Per node it is an index seek.
export const LATEST_REVISION = `
  JOIN revisions lr ON lr.node_id = n.id
    AND lr.rev = (SELECT MAX(r.rev) FROM revisions r WHERE r.node_id = n.id)
`;

// Shared projection: every node joined to its latest revision + live edge count.
export const ENRICHED = `
  SELECT n.id, n.memory_kind, n.type, n.title, n.project, n.valid_from, n.invalidated_at,
         lr.rev AS rev, lr.ts AS updated, lr.content AS content,
         (SELECT COUNT(*) FROM edges e
            WHERE (e.src = n.id OR e.dst = n.id) AND e.invalidated_at IS NULL) AS edge_count,
         n.use_count, n.last_used_at
  FROM nodes n
  ${LATEST_REVISION}
`;

// The two vector pools (migration 013). Both are vec0 tables over the same space and
// metric; which one a chunk belongs to follows from its node alone.
export const AUTHORED_VEC = "chunk_vec";
export const CODE_VEC = "code_vec";
export type VectorPool = typeof AUTHORED_VEC | typeof CODE_VEC;

export function vectorPoolFor(db: Database.Database, nodeId: string): VectorPool {
  const row = db
    .prepare("SELECT memory_kind AS kind, origin FROM nodes WHERE id = ?")
    .get(nodeId) as { kind: string; origin: string | null } | undefined;

  return row?.kind === MemoryKind.MIRROR && row.origin === CODE_ORIGIN ? CODE_VEC : AUTHORED_VEC;
}

export function enrichedById(db: Database.Database, id: string): EnrichedRow | undefined {
  return db.prepare(`${ENRICHED} WHERE n.id = ?`).get(id) as EnrichedRow | undefined;
}

export function enrichedByIds(db: Database.Database, ids: string[]): EnrichedRow[] {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`${ENRICHED} WHERE n.id IN (${ph})`).all(...ids) as EnrichedRow[];
}

export function insertRevision(
  db: Database.Database,
  id: string,
  rev: number,
  content: string,
  session_id: string,
  reason: string | null,
  ts: string,
): void {
  db.prepare(
    "INSERT INTO revisions (node_id, rev, content, session_id, reason, ts) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, rev, content, session_id, reason, ts);
}

export function ftsPut(db: Database.Database, id: string, title: string, content: string): void {
  db.prepare("DELETE FROM node_fts WHERE node_id = ?").run(id);
  db.prepare("INSERT INTO node_fts (node_id, title, content) VALUES (?, ?, ?)").run(
    id,
    title,
    content,
  );
}

export function countUnembedded(db: Database.Database, nodeId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM chunks c
         WHERE c.node_id = ? AND c.stale = 0
           AND NOT EXISTS (SELECT 1 FROM embedding_meta m WHERE m.chunk_id = c.id)`,
      )
      .get(nodeId) as { c: number }
  ).c;
}

export function refreshQueue(db: Database.Database, nodeId: string, ts: string): void {
  if (countUnembedded(db, nodeId) > 0) {
    db.prepare(
      `INSERT INTO embedding_queue (node_id, enqueued_at, attempts, last_error) VALUES (?, ?, 0, NULL)
       ON CONFLICT(node_id) DO UPDATE SET enqueued_at = excluded.enqueued_at, attempts = 0, last_error = NULL`,
    ).run(nodeId, ts);
    db.prepare("UPDATE nodes SET pending_embedding = 1 WHERE id = ?").run(nodeId);
  } else {
    db.prepare("DELETE FROM embedding_queue WHERE node_id = ?").run(nodeId);
    db.prepare("UPDATE nodes SET pending_embedding = 0 WHERE id = ?").run(nodeId);
  }
}

// Diff the node's current chunk set against what's stored: unchanged ids keep their
// vectors, dropped ids go stale, and the node is (re)queued only if some current
// chunk still lacks an embedding. Runs inside the caller's write transaction.
export function syncChunks(
  db: Database.Database,
  nodeId: string,
  rev: number,
  content: string,
  ts: string,
): void {
  const chunks = chunkContent(nodeId, content);
  const newIds = new Set(chunks.map((c) => c.id));
  const existing = db.prepare("SELECT id FROM chunks WHERE node_id = ?").all(nodeId) as {
    id: string;
  }[];

  const upsert = db.prepare(
    `INSERT INTO chunks (id, node_id, rev, heading_path, seq, text, stale)
     VALUES (@id, @node_id, @rev, @heading_path, @seq, @text, 0)
     ON CONFLICT(id) DO UPDATE SET rev = @rev, seq = @seq, heading_path = @heading_path, stale = 0`,
  );
  for (const c of chunks) {
    upsert.run({
      id: c.id,
      node_id: nodeId,
      rev,
      heading_path: c.heading_path,
      seq: c.seq,
      text: c.text,
    });
  }
  const markStale = db.prepare("UPDATE chunks SET stale = 1 WHERE id = ?");
  for (const row of existing) if (!newIds.has(row.id)) markStale.run(row.id);

  refreshQueue(db, nodeId, ts);
}

export { MAX_EMBED_ATTEMPTS };
