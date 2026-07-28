export const RERANK_PROVIDER_TOKEN = Symbol("RerankProvider");

// A second-stage reranker: given the query and the fused candidates' short docs,
// return a relevance score in [0,1] per doc, aligned to input order. Providers own
// their model/scoring. A disabled provider reports `enabled=false` and `search` skips
// the stage entirely — the RRF ordering stands (the default). Reranking never touches
// graph-expanded neighbors and never changes which fields a result returns.
export interface RerankProvider {
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;

  rerank(query: string, docs: string[]): Promise<number[]>;
}
