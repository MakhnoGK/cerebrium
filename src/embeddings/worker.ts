import type { EmbeddingProvider } from "@/embeddings/provider";
import { newId } from "@/core/ids";
import { inject, injectable } from "tsyringe";
import { EmbeddingQueueRepo } from "@/db/repositories";
import { EMBEDDING_PROVIDER_TOKEN } from ".";

const EMBED_LEASE = "embedding";

export interface WorkerOptions {
  batchSize?: number;
  intervalMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  leaseTtlMs?: number;
}

// In-process, async embedding drain. Runs in the same OS process as the single
// writer (only the main thread touches the DB). A pending node is fully findable
// via FTS in the meantime — nothing here is on the write path.
@injectable()
export class EmbeddingWorker {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly leaseTtlMs: number;
  private readonly ownerId = newId();

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly embeddingQueue: EmbeddingQueueRepo,
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
  ) {
    this.batchSize = 16;
    this.intervalMs = 3000;
    this.backoffBaseMs = 1000;
    this.backoffCapMs = 60_000;

    // Comfortably longer than the tick interval so the holder keeps the lease
    // across normal ticks; if the process dies, another takes over after it lapses.
    this.leaseTtlMs = Math.max(this.intervalMs * 20, 60_000);
  }

  start(): void {
    this.reconcile();

    if (this.timer) {
      return;
    }

    // Overlap guard: `running` skips a tick still in flight; unref so the timer
    // never keeps the process alive on its own.
    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }

      this.running = true;

      void this.tick().finally(() => (this.running = false));
    }, this.intervalMs);

    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.embeddingQueue.releaseWorkerLease(EMBED_LEASE, this.ownerId);
  }

  reconcile(): void {
    this.embeddingQueue.reconcilePending(this.now());
  }

  // One batch across queued nodes. Deterministic and side-effecting: tests call it
  // directly with a fixed clock instead of waiting on the interval.
  async tick(): Promise<{ embedded: number; failed: number }> {
    const now = this.now();
    // Only the lease holder drains — keeps N per-session server processes from all
    // writing embeddings to the shared DB at once.

    const isWorkerLeased = await this.embeddingQueue.holdWorkerLease(
      EMBED_LEASE,
      this.ownerId,
      this.leaseTtlMs,
      now,
    );

    if (!isWorkerLeased) {
      return { embedded: 0, failed: 0 };
    }

    const candidates = this.embeddingQueue
      .queueRows(this.batchSize * 4)
      .filter((r) => this.eligible(r.attempts, r.enqueued_at, now));

    if (!candidates.length) {
      return { embedded: 0, failed: 0 };
    }

    const nodeIds = candidates.map((c) => c.node_id);
    const chunks = this.embeddingQueue.unembeddedChunks(nodeIds, this.batchSize);

    if (!chunks.length) {
      for (const id of nodeIds) {
        this.embeddingQueue.finalizeNode(id, now);
      }

      return { embedded: 0, failed: 0 };
    }

    let vectors: number[][];

    try {
      vectors = await this.provider.embed(
        chunks.map((c) => c.text),
        "passage",
      );
    } catch (err) {
      const involved = [...new Set(chunks.map((c) => c.node_id))];

      this.embeddingQueue.recordEmbeddingFailure(
        involved,
        (err as Error).message || String(err),
        this.now(),
      );

      return { embedded: 0, failed: involved.length };
    }

    const byNode = new Map<string, { chunkId: string; vector: number[] }[]>();

    chunks.forEach((c, i) => {
      const list = byNode.get(c.node_id) ?? [];
      list.push({ chunkId: c.id, vector: vectors[i]! });
      byNode.set(c.node_id, list);
    });

    const batch = [...byNode].map(([nodeId, items]) => ({ nodeId, items }));

    this.embeddingQueue.commitBatchEmbeddings(
      batch,
      this.provider.name,
      this.provider.version,
      this.now(),
    );

    for (const id of nodeIds) {
      if (!byNode.has(id)) {
        this.embeddingQueue.finalizeNode(id, now);
      }
    }

    return { embedded: chunks.length, failed: 0 };
  }

  private now(): string {
    return new Date().toISOString();
  }

  private eligible(attempts: number, enqueuedAt: string, now: string): boolean {
    if (attempts === 0) {
      return true;
    }

    const backoff = Math.min(this.backoffBaseMs * 2 ** (attempts - 1), this.backoffCapMs);

    return Date.parse(now) - Date.parse(enqueuedAt) >= backoff;
  }
}
