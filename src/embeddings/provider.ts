// Query and passage embeddings can differ (asymmetric models like E5), so `role`
// is part of the contract. Providers own any model-specific prompt prefixing.
export interface EmbeddingProvider {
  readonly name: string;
  readonly version: string;
  readonly dim: number;
  embed(texts: string[], role: "query" | "passage"): Promise<number[][]>;
}

// The dimension baked into the chunk_vec vec0 table (schema.sql). A provider whose
// dim differs cannot share this DB; the factory fails loudly at startup.
export const VECTOR_DIM = 384;
