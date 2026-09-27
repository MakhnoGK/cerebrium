import { injectable } from "tsyringe";
import type { QueueRow, UnembeddedChunk } from "@cerebrium/contracts/types";
import type { ChunkVector, EmbeddingQueueRepo } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import {
  ACTIVE_SPACE,
  countUnembedded,
  enrichedById,
  MAX_EMBED_ATTEMPTS,
  refreshQueue,
  syncChunks,
  toVectorLiteral,
} from "@/db/postgres/internal";

@injectable()
export class PgEmbeddingQueueRepo extends PgBaseRepo implements EmbeddingQueueRepo {
  async queueRows(limit: number): Promise<QueueRow[]> {
    return this.all<QueueRow>(
      `SELECT node_id, enqueued_at, attempts FROM embedding_queue
       WHERE attempts < @max ORDER BY enqueued_at ASC, node_id ASC LIMIT @limit`,
      { max: MAX_EMBED_ATTEMPTS, limit },
    );
  }

  async unembeddedChunks(nodeIds: string[], limit: number): Promise<UnembeddedChunk[]> {
    if (!nodeIds.length) return [];

    return this.all<UnembeddedChunk>(
      `SELECT c.id, c.node_id, c.text FROM chunks c
       WHERE c.node_id = ANY(@nodeIds) AND c.stale = 0
         AND NOT EXISTS (
           SELECT 1 FROM chunk_vectors v WHERE v.space_id = ${ACTIVE_SPACE} AND v.chunk_id = c.id
         )
       ORDER BY c.node_id, c.seq LIMIT @limit`,
      { nodeIds, limit },
    );
  }

  async commitNodeEmbeddings(
    nodeId: string,
    items: ChunkVector[],
    model: string,
    version: string,
    ts: string,
  ): Promise<void> {
    await this.commitBatchEmbeddings([{ nodeId, items }], model, version, ts);
  }

  // Vectors land only in the active space, and only from the model that space was built with.
  async commitBatchEmbeddings(
    batch: { nodeId: string; items: ChunkVector[] }[],
    model: string,
    version: string,
    ts: string,
  ): Promise<void> {
    if (!batch.length) return;

    await this.tx(async () => {
      const space = await this.one<{ id: number; model: string; dim: number }>(
        "SELECT id, model, dim FROM vector_spaces WHERE active",
      );

      if (!space) throw new Error("the Postgres store has no active vector space");

      if (space.model !== model) {
        throw new Error(
          `embedding model '${model}' does not match the active vector space (${space.model})`,
        );
      }

      for (const { nodeId, items } of batch) {
        for (const it of items) {
          if (it.vector.length !== space.dim) {
            throw new Error(
              `a ${String(it.vector.length)}-d vector does not fit the active ${String(space.dim)}-d space`,
            );
          }

          await this.db.query(
            `INSERT INTO chunk_vectors (space_id, chunk_id, embedding, model_version, ts)
             VALUES (@space, @chunkId, @embedding::vector, @version, @ts)
             ON CONFLICT (space_id, chunk_id) DO UPDATE SET
               embedding = excluded.embedding, model_version = excluded.model_version, ts = excluded.ts`,
            {
              space: space.id,
              chunkId: it.chunkId,
              embedding: toVectorLiteral(it.vector),
              version,
              ts,
            },
          );
        }

        await this.finalize(nodeId, ts);
      }
    });
  }

  async finalizeNode(nodeId: string, ts: string): Promise<void> {
    await this.tx(() => this.finalize(nodeId, ts));
  }

  private async finalize(nodeId: string, ts: string): Promise<void> {
    if ((await countUnembedded(this.db, nodeId)) === 0) {
      await this.db.query("UPDATE nodes SET pending_embedding = 0 WHERE id = @nodeId", { nodeId });
      await this.db.query("DELETE FROM embedding_queue WHERE node_id = @nodeId", { nodeId });
    } else {
      await this.db.query(
        `UPDATE embedding_queue SET attempts = 0, last_error = NULL, enqueued_at = @ts
         WHERE node_id = @nodeId`,
        { ts, nodeId },
      );
    }
  }

  async recordEmbeddingFailure(nodeIds: string[], error: string, ts: string): Promise<void> {
    if (!nodeIds.length) return;

    await this.run(
      `UPDATE embedding_queue SET attempts = attempts + 1, last_error = @error, enqueued_at = @ts
       WHERE node_id = ANY(@nodeIds)`,
      { error: error.slice(0, 500), ts, nodeIds },
    );
  }

  async holdWorkerLease(role: string, owner: string, ttlMs: number, now: string): Promise<boolean> {
    const expires = new Date(Date.parse(now) + ttlMs).toISOString();

    return this.tx(async () => {
      await this.db.query(
        `INSERT INTO worker_lease (role, owner, expires_at) VALUES (@role, @owner, @expires)
         ON CONFLICT (role) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE worker_lease.owner = excluded.owner OR worker_lease.expires_at <= @now`,
        { role, owner, expires, now },
      );

      const after = await this.one<{ owner: string }>(
        "SELECT owner FROM worker_lease WHERE role = @role",
        { role },
      );

      return after?.owner === owner;
    });
  }

  async releaseWorkerLease(role: string, owner: string): Promise<void> {
    await this.run("DELETE FROM worker_lease WHERE role = @role AND owner = @owner", {
      role,
      owner,
    });
  }

  async reconcilePending(ts: string): Promise<void> {
    const pending = await this.all<{ id: string }>(
      "SELECT id FROM nodes WHERE pending_embedding = 1 ORDER BY id",
    );

    for (const { id } of pending) {
      await this.tx(async () => {
        const hasChunks = await this.one("SELECT 1 FROM chunks WHERE node_id = @id LIMIT 1", {
          id,
        });
        const hasQueue = await this.one("SELECT 1 FROM embedding_queue WHERE node_id = @id", {
          id,
        });

        if (!hasChunks) {
          const row = await enrichedById(this.db, id);

          if (row) await syncChunks(this.db, id, row.rev, row.content, ts);
        } else if (!hasQueue) {
          await refreshQueue(this.db, id, ts);
        }
      });
    }
  }

  async embeddingStats(): Promise<{ backlog: number; parked: number }> {
    const row = await this.one<{ backlog: number | null; parked: number | null }>(
      `SELECT SUM(CASE WHEN attempts < @max THEN 1 ELSE 0 END) AS backlog,
              SUM(CASE WHEN attempts >= @max THEN 1 ELSE 0 END) AS parked FROM embedding_queue`,
      { max: MAX_EMBED_ATTEMPTS },
    );

    return { backlog: row?.backlog ?? 0, parked: row?.parked ?? 0 };
  }
}
