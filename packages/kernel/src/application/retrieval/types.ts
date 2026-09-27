import type { EnrichedRow, SearchRow, VectorRow } from "@cerebrium/contracts/types";
import type { Duplicate, MatchedBy } from "@/application/use-cases/contracts/search";

export type Row = SearchRow | VectorRow | EnrichedRow;

export interface Entry {
  row: Row;
  score: number;
  matched: MatchedBy;
  best_chunk?: string;
  section?: string;
  via?: { node: string; edge: string };
}

export interface Selection {
  entry: Entry;
  duplicates: Duplicate[];
}
