export const EMBEDDING_PROVIDER_TOKEN = Symbol("EmbeddingProvider");

export const VECTOR_DIM = 384;

// Query and passage embeddings can differ (asymmetric models like E5), so `role`
// is part of the contract. Providers own any model-specific prompt prefixing.
export interface EmbeddingProvider {
  readonly name: string;
  readonly version: string;
  readonly dim: number;

  embed(texts: string[], role: EmbeddingRole): Promise<number[][]>;
}

export enum EmbeddingRole {
  QUERY = "query",
  PASSAGE = "passage",
}
