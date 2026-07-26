import type { QueueRow, UnembeddedChunk } from "@/core/types";
import { BaseRepo, MAX_EMBED_ATTEMPTS } from "@/db/repositories/base";
import {
  countUnembedded,
  enrichedById,
  refreshQueue,
  syncChunks,
} from "@/db/repositories/internal";
import { injectable } from "tsyringe";

// The async-embedding drain side of the queue: candidate selection, vector commits,
// per-node finalization, failure backoff, worker-lease election, and startup
// reconciliation. The write-side enqueue (refreshQueue) lives with the node write in
// internal.ts; this repo owns everything the daemon touches while draining.
@injectable()
export class EmbeddingQueueRepo extends BaseRepo {
  // Nodes eligible for an embedding attempt: not parked (attempts < max), oldest first.
  queueRows(limit: number): QueueRow[] {
    return this.db
      .prepare(
        `SELECT node_id, enqueued_at, attempts FROM embedding_queue
         WHERE attempts < ? ORDER BY enqueued_at ASC, node_id ASC LIMIT ?`,
      )
      .all(MAX_EMBED_ATTEMPTS, limit) as QueueRow[];
  }

  unembeddedChunks(nodeIds: string[], limit: number): UnembeddedChunk[] {
    if (!nodeIds.length) return [];
    const ph = nodeIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT c.id, c.node_id, c.text FROM chunks c
         WHERE c.node_id IN (${ph}) AND c.stale = 0
           AND NOT EXISTS (SELECT 1 FROM embedding_meta m WHERE m.chunk_id = c.id)
         ORDER BY c.node_id, c.seq LIMIT ?`,
      )
      .all(...nodeIds, limit) as UnembeddedChunk[];
  }

  // Vector upserts + node bookkeeping in one transaction, per the async-embedding
  // exception to the write-in-transaction invariant. vec0 has no upsert, so
  // delete-then-insert.
  commitNodeEmbeddings(
    nodeId: string,
    items: { chunkId: string; vector: number[] }[],
    model: string,
    version: string,
    ts: string,
  ): void {
    this.commitBatchEmbeddings([{ nodeId, items }], model, version, ts);
  }

  // One transaction for a whole tick's worth of nodes. Batching matters under
  // contention: the write lock is taken once per tick, not once per node, so a
  // 64-node tick no longer fights other writers 64 separate times.
  commitBatchEmbeddings(
    batch: { nodeId: string; items: { chunkId: string; vector: number[] }[] }[],
    model: string,
    version: string,
    ts: string,
  ): void {
    if (!batch.length) return;
    const delVec = this.db.prepare("DELETE FROM chunk_vec WHERE chunk_id = ?");
    const insVec = this.db.prepare("INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)");
    const meta = this.db.prepare(
      `INSERT INTO embedding_meta (chunk_id, model, model_version, ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, model_version = excluded.model_version, ts = excluded.ts`,
    );
    this.tx(() => {
      for (const { nodeId, items } of batch) {
        for (const it of items) {
          delVec.run(it.chunkId);
          insVec.run(it.chunkId, JSON.stringify(it.vector));
          meta.run(it.chunkId, model, version, ts);
        }
        this.finalizeNode(nodeId, ts);
      }
    });
  }

  // Node fully embedded -> clear pending + dequeue. Otherwise a batch made partial
  // progress, so clear the failure backoff and leave it queued for the next tick.
  finalizeNode(nodeId: string, ts: string): void {
    if (countUnembedded(this.db, nodeId) === 0) {
      this.db.prepare("UPDATE nodes SET pending_embedding = 0 WHERE id = ?").run(nodeId);
      this.db.prepare("DELETE FROM embedding_queue WHERE node_id = ?").run(nodeId);
    } else {
      this.db
        .prepare(
          "UPDATE embedding_queue SET attempts = 0, last_error = NULL, enqueued_at = ? WHERE node_id = ?",
        )
        .run(ts, nodeId);
    }
  }

  recordEmbeddingFailure(nodeIds: string[], error: string, ts: string): void {
    const stmt = this.db.prepare(
      "UPDATE embedding_queue SET attempts = attempts + 1, last_error = ?, enqueued_at = ? WHERE node_id = ?",
    );
    this.tx(() => {
      for (const id of nodeIds) stmt.run(error.slice(0, 500), ts, id);
    });
  }

  // Claim or renew the embedding-drain lease. Returns true iff the caller holds it
  // after this call. A live lease held by someone else is left untouched (no write);
  // an expired one or the caller's own is (re)claimed atomically, so concurrent
  // server processes converge on a single active worker.
  holdWorkerLease(role: string, owner: string, ttlMs: number, now: string): boolean {
    const expires = new Date(Date.parse(now) + ttlMs).toISOString();
    const cur = this.db
      .prepare("SELECT owner, expires_at FROM worker_lease WHERE role = ?")
      .get(role) as { owner: string; expires_at: string } | undefined;
    if (cur && cur.owner !== owner && cur.expires_at > now) return false;
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO worker_lease (role, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(role) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
             WHERE worker_lease.owner = excluded.owner OR worker_lease.expires_at <= ?`,
        )
        .run(role, owner, expires, now);
    });
    const after = this.db.prepare("SELECT owner FROM worker_lease WHERE role = ?").get(role) as
      { owner: string } | undefined;
    return after?.owner === owner;
  }

  releaseWorkerLease(role: string, owner: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM worker_lease WHERE role = ? AND owner = ?").run(role, owner);
    });
  }

  // Startup recovery: chunk any pending node that predates chunking, and re-queue
  // any pending node missing its queue row. The queue itself survives restarts.
  reconcilePending(ts: string): void {
    const pending = this.db.prepare("SELECT id FROM nodes WHERE pending_embedding = 1").all() as {
      id: string;
    }[];
    for (const { id } of pending) {
      const hasChunks = this.db.prepare("SELECT 1 FROM chunks WHERE node_id = ? LIMIT 1").get(id);
      if (!hasChunks) {
        const row = enrichedById(this.db, id);
        if (row)
          this.tx(() => {
            syncChunks(this.db, id, row.rev, row.content, ts);
          });
      } else if (!this.db.prepare("SELECT 1 FROM embedding_queue WHERE node_id = ?").get(id)) {
        refreshQueue(this.db, id, ts);
      }
    }
  }

  embeddingStats(): { backlog: number; parked: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(CASE WHEN attempts < ? THEN 1 ELSE 0 END) AS backlog,
                SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS parked FROM embedding_queue`,
      )
      .get(MAX_EMBED_ATTEMPTS, MAX_EMBED_ATTEMPTS) as {
      backlog: number | null;
      parked: number | null;
    };
    return { backlog: row.backlog ?? 0, parked: row.parked ?? 0 };
  }
}
