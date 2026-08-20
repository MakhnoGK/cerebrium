import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { Envelope } from "@/core/types";
import type { MemoryKind } from "@/core/vocab";

export type SearchMode = "hybrid" | "text" | "vector";
export type MatchedBy = "text" | "vector" | "both" | "graph";

export interface SearchQuery {
  query: string;
  limit: number;
  project?: string;
  kinds?: MemoryKind[];
  types?: string[];
  history?: boolean;
  mode?: SearchMode;
  expand_graph?: boolean;
  as_of?: string;
  valid_at?: string;
}

// A near-duplicate that gave up its slot to the result carrying it. Still addressable —
// `get` it by id like any other node.
export interface Duplicate {
  id: string;
  title: string;
  score: number;
  // Set when a reviewed `duplicate_of` edge decided this, not the similarity gate.
  recorded?: true;
}

// A result is an envelope plus why it surfaced. `summary` is optional because it is dropped
// when `best_chunk` already carries the same text (see `summaryIsRedundant`).
export type SearchResult = Omit<Envelope, "summary"> & {
  summary?: string;
  matched?: MatchedBy;
  best_chunk?: string;
  section?: string;
  via?: { node: string; edge: string };
  duplicates?: Duplicate[];
};

// The retrieval-outcome record. `query` + `ids`, joined against the ids a later `get`
// fetched, are the implicit relevance signal; `matched` runs parallel to `ids` so an
// ignored result can be attributed to the path that produced it.
export interface SearchAudit {
  mode: string;
  query: string;
  results: number;
  ids: string[];
  matched: MatchedBy[];
  folded: { id: string; into: string; score: number; recorded?: true }[];
}

export interface SearchOutcome {
  results: SearchResult[];
  total_matches: number;
  notes: string[];
  audit: SearchAudit;
}

export type SearchMemory = UseCase<SearchQuery, SearchOutcome>;

export const SEARCH_MEMORY = useCaseToken<SearchQuery, SearchOutcome>("SearchMemory");
