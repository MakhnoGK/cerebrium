import { BEST_CHUNK_CHARS, RRF_K } from "@/application/retrieval/constants";
import { memoryFactor, strengthFactor, symbolFactor } from "@/application/retrieval/scoring";
import type { Entry, Row } from "@/application/retrieval/types";
import type { SearchRow, VectorRow } from "@/core/types";

export interface FtsChunk {
  chunk_text: string;
  chunk_heading: string | null;
}

export interface FuseInput {
  ftsRows: SearchRow[];
  ftsChunks: Map<string, FtsChunk>;
  vecRows: VectorRow[];
  now: number;
  history: boolean;
  penalty: number;
  useWeight: number;
}

interface Fused {
  row: Row;
  rrf: number;
  text: boolean;
  vector: boolean;
  best_chunk?: string;
  section?: string;
}

// Reciprocal-rank fusion of the two candidate branches, then the memory model applied to
// each survivor. The branches are independent and either may be empty.
export function fuse({
  ftsRows,
  ftsChunks,
  vecRows,
  now,
  history,
  penalty,
  useWeight,
}: FuseInput): Map<string, Entry> {
  const fused = new Map<string, Fused>();

  ftsRows.forEach((row, i) => {
    const e = fused.get(row.id) ?? { row, rrf: 0, text: false, vector: false };

    e.rrf += 1 / (RRF_K + i + 1);
    e.text = true;

    const chunk = ftsChunks.get(row.id);
    if (chunk && !e.best_chunk) {
      e.best_chunk = chunk.chunk_text.slice(0, BEST_CHUNK_CHARS);
      e.section = chunk.chunk_heading ?? undefined;
    }

    fused.set(row.id, e);
  });

  vecRows.forEach((row, i) => {
    const e = fused.get(row.id) ?? { row, rrf: 0, text: false, vector: false };

    e.rrf += 1 / (RRF_K + i + 1);
    e.vector = true;

    if (!e.best_chunk) {
      e.best_chunk = row.chunk_text.slice(0, BEST_CHUNK_CHARS);
      // Only a headed chunk is worth naming: a preamble match means the node is short
      // or the hit is in its opening, and neither is a section worth narrowing to.
      e.section = row.chunk_heading ?? undefined;
    }

    fused.set(row.id, e);
  });

  const entries = new Map<string, Entry>();

  for (const e of fused.values()) {
    entries.set(e.row.id, {
      row: e.row,
      score:
        e.rrf *
        memoryFactor(e.row, now, history) *
        symbolFactor(e.row, penalty) *
        strengthFactor(e.row, useWeight),
      matched: e.text && e.vector ? "both" : e.vector ? "vector" : "text",
      best_chunk: e.best_chunk,
      section: e.section,
    });
  }

  return entries;
}
