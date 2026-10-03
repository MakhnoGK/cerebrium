export interface VectorSpace {
  id: number;
  model: string;
  dim: number;
  active: boolean;
  created_at: string;
}

export const VECTOR_SPACES_REPO_TOKEN = Symbol("VectorSpacesRepo");

// The embedding spaces a store holds. A model swap fills a second space beside the active
// one and then activates it.
export interface VectorSpacesRepo {
  spaces(): Promise<VectorSpace[]>;
  // The space for `model`, created inactive when it does not exist yet.
  ensureSpace(model: string, dim: number, ts: string): Promise<VectorSpace>;
  // Live chunks with no vector in `space`.
  unembeddedChunks(space: number, limit: number): Promise<{ id: string; text: string }[]>;
  putChunkVectors(
    space: number,
    rows: { chunkId: string; vector: number[] }[],
    modelVersion: string,
    ts: string,
  ): Promise<void>;
  coverage(space: number): Promise<{ chunks: number; embedded: number }>;
  activate(space: number): Promise<void>;
}
