import type { RerankProvider } from "@/rerank/provider";

// Deterministic, offline reranker for tests and CI: scores each doc by the fraction
// of distinct query terms it contains (lexical recall). No model download — enough to
// exercise the rerank stage (reordering, decay interaction, graceful fallback) with a
// fixed, inspectable score. Mirrors the local-null embedding provider's role.
export class LocalNullReranker implements RerankProvider {
  readonly name = "local-null";
  readonly version = "1";
  readonly enabled = true;

  async rerank(query: string, docs: string[]): Promise<number[]> {
    const q = tokens(query);
    if (q.size === 0) return docs.map(() => 0);
    return docs.map((doc) => {
      const dt = tokens(doc);
      let hit = 0;
      for (const t of q) if (dt.has(t)) hit++;
      return hit / q.size;
    });
  }
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}
