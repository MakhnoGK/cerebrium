import type { RerankProvider } from "@/rerank/provider";
import { LocalNullReranker } from "@/rerank/local-null";
import { LocalReranker } from "@/rerank/local";

export type { RerankProvider } from "@/rerank/provider";

export const RERANK_PROVIDER_TOKEN = Symbol("RerankProvider");

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
  if (name === "local") return new LocalReranker();
  if (name === "local-null") return new LocalNullReranker();
  return new DisabledReranker();
}
