import type { QueueRow, UnembeddedChunk } from "@cerebrium/contracts/types";

export interface ChunkVector {
  chunkId: string;
  vector: number[];
}

export const EMBEDDING_QUEUE_REPO_TOKEN = Symbol("EmbeddingQueueRepo");

export interface EmbeddingQueueRepo {
  queueRows(limit: number): Promise<QueueRow[]>;
  unembeddedChunks(nodeIds: string[], limit: number): Promise<UnembeddedChunk[]>;
  commitNodeEmbeddings(
    nodeId: string,
    items: ChunkVector[],
    model: string,
    version: string,
    ts: string,
  ): Promise<void>;
  commitBatchEmbeddings(
    batch: { nodeId: string; items: ChunkVector[] }[],
    model: string,
    version: string,
    ts: string,
  ): Promise<void>;
  finalizeNode(nodeId: string, ts: string): Promise<void>;
  recordEmbeddingFailure(nodeIds: string[], error: string, ts: string): Promise<void>;
  holdWorkerLease(role: string, owner: string, ttlMs: number, now: string): Promise<boolean>;
  releaseWorkerLease(role: string, owner: string): Promise<void>;
  reconcilePending(ts: string): Promise<void>;
  embeddingStats(): Promise<{ backlog: number; parked: number }>;
}
