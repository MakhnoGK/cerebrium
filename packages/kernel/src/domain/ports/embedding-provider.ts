export const EMBEDDING_PROVIDER_TOKEN = Symbol("EmbeddingProvider");

export const VECTOR_DIM = 384;

// Query and passage embeddings can differ (asymmetric models like E5), so `role`
// is part of the contract. Providers own any model-specific prompt prefixing.
export interface EmbeddingProvider {
  readonly name: string;
  readonly version: string;
  readonly dim: number;

  embed(texts: string[], role: EmbeddingRole): Promise<number[][]>;

  // Load whatever `embed` would otherwise load on first call. Optional: a provider with
  // no load cost has nothing to do. Loading a local model blocks the event loop for
  // ~111ms, so a long-lived host calls this when nobody is waiting rather than paying it
  // inside the first request that happens to need an embedding.
  warm?(): Promise<void>;
}

export enum EmbeddingRole {
  QUERY = "query",
  PASSAGE = "passage",
}
