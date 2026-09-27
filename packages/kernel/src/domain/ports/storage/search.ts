import type { EnrichedRow, Envelope, SearchRow, VectorRow } from "@cerebrium/contracts/types";
import type { TextQuery } from "@/core/fts";

export interface SearchFilters {
  project?: string;
  kinds?: string[];
  types?: string[];
  history: boolean;
  cap: number;
  asOf?: string;
  validAt?: string;
}

export const SEARCH_REPO_TOKEN = Symbol("SearchRepo");

export interface SearchRepo {
  vectorSearch(embedding: number[], opts: SearchFilters): Promise<VectorRow[]>;
  search(opts: SearchFilters & { text: TextQuery }): Promise<{ rows: SearchRow[]; total: number }>;
  rowsFor(ids: string[], opts?: { asOf?: string; validAt?: string }): Promise<EnrichedRow[]>;
  vectorsFor(ids: string[]): Promise<Map<string, Float32Array>>;
  bestFtsChunksFor(
    ids: string[],
    text: TextQuery,
  ): Promise<Map<string, { chunk_text: string; chunk_heading: string | null }>>;
  validSemantic(project: string | undefined, limit: number): Promise<Envelope[]>;
  lastCheckpoints(
    project: string | undefined,
    limit: number,
  ): Promise<{ envelope: Envelope; content: string }[]>;
  validTasks(project: string | undefined, limit: number): Promise<Envelope[]>;
  recentValid(project: string | undefined, limit: number): Promise<Envelope[]>;
}
