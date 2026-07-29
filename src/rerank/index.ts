import { type RerankProvider } from "@/domain/ports/rerank-provider";
import { LocalReranker } from "@/rerank/local";
import { LocalNullReranker } from "@/rerank/local-null";

// The disabled default: `search` checks `enabled` and skips the rerank stage, leaving
// the RRF ordering untouched. `rerank` is never called, but returns zeros for safety.
class DisabledReranker implements RerankProvider {
  readonly name = "off";
  readonly version = "1";
  readonly enabled = false;
  async rerank(_query: string, docs: string[]): Promise<number[]> {
    return docs.map(() => 0);
  }
}

// Reranker chosen by env at startup (default off). Adding a paid/cloud reranker is a
// one-file change here plus a class — the interface is the whole contract.
export function createReranker(name = process.env.MEMORY_RERANK || "off"): RerankProvider {
  switch (name) {
    case "local":
      return new LocalReranker();
    case "local-null":
      return new LocalNullReranker();
    default:
      return new DisabledReranker();
  }
}
