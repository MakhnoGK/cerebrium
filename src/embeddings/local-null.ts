// Deterministic, offline pseudo-embeddings for tests and CI: a hashed bag of words
// (feature hashing) so texts sharing tokens land close in cosine space and disjoint
// texts land near-orthogonal — enough to exercise KNN, RRF, and dedup without a
// model download. `role` is ignored so a query self-matches its passage.
import { VECTOR_DIM, type EmbeddingProvider } from "@/domain/ports/embedding-provider";

export class LocalNullProvider implements EmbeddingProvider {
  readonly name = "local-null";
  readonly version = "1";
  readonly dim: number;

  constructor(dim = VECTOR_DIM) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

    for (const tok of tokens) {
      const h = fnv1a(tok);
      const idx = h % this.dim;

      v[idx]! += (h & 1) === 0 ? 1 : -1;
    }

    const norm = Math.hypot(...v);

    if (norm === 0) {
      v[0] = 1; // empty text -> a fixed unit vector, never NaN
      return v;
    }

    return v.map((x) => x / norm);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return h >>> 0;
}
