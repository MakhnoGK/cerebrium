import { normalize, pairwise, rawSimilarity, round3 } from "@/application/retrieval/scoring";
import type { Entry, Selection } from "@/application/retrieval/types";
import type { Duplicate } from "@/application/use-cases/contracts/search";

export interface DiversifyInput {
  vectors: Map<string, Float32Array>;
  protectedPairs: Set<string>;
  recordedPairs: Set<string>;
  foldSim: number;
  mmrLambda: number;
}

// Maximal Marginal Relevance at the cut: pick greedily by relevance minus the
// redundancy against what is already selected, so the returned window repeats itself
// less. Both terms are min-max normalized within this candidate set — unlike the merge
// gate, nothing here crosses an absolute threshold, and the raw scales (RRF ~0.016 vs
// cosine confined to 0.85-1.00 by anisotropy) are not comparable. Candidates with no
// stored vector carry no redundancy, so a not-yet-embedded node is never demoted.
// Picks the slots and folds near-duplicates into them in one pass. A folded result is
// still returned — under its representative, with its id — so the cost of a wrong fold
// is one line further down, not a missing node. Folding is always against a result
// already selected, never transitive: single-linkage clustering on this corpus chains a
// third of the store into one component, and this is what stops that.
export function selectDiverse(
  ordered: Entry[],
  limit: number,
  { vectors, protectedPairs, recordedPairs, foldSim, mmrLambda }: DiversifyInput,
): Selection[] {
  const raw = rawSimilarity(ordered, vectors);
  const ids = ordered.map((e) => e.row.id);
  // `>= 1` is off, matching `mmrLambda`: a plain `>=` gate would still fire at 1.0,
  // since two identical vectors score exactly 1. It turns the whole fold off, recorded
  // duplicates included.
  const folding = foldSim < 1;
  const keyOf = (a: number, b: number) => {
    const [x, y] = [ids[a]!, ids[b]!];

    return x < y ? `${x}|${y}` : `${y}|${x}`;
  };
  // A `duplicate_of` edge is a reviewed verdict, so it folds whatever the vectors now
  // say — content drifts, and re-deciding a settled pair on every query would let a
  // revision quietly undo the review. Direction is not honoured: the edge names the
  // pair, the query names which of them is worth the slot.
  const foldable = (a: number, b: number) => {
    if (!folding) return false;

    const key = keyOf(a, b);

    if (protectedPairs.has(key)) return false;

    return recordedPairs.has(key) || raw(a, b) >= foldSim;
  };

  const useMmr = mmrLambda < 1 && vectors.size > 0;
  const relevance = normalize(ordered.map((e) => e.score));
  const similarity = pairwise(ordered, vectors);
  const redundancy = ordered.map(() => 0);

  const pool = ordered.map((_, index) => index);
  const selected: Selection[] = [];

  while (selected.length < limit && pool.length) {
    let bestSlot = 0;

    if (useMmr) {
      let bestScore = -Infinity;

      pool.forEach((index, slot) => {
        const marginal = mmrLambda * relevance[index]! - (1 - mmrLambda) * redundancy[index]!;

        if (marginal > bestScore) {
          bestScore = marginal;
          bestSlot = slot;
        }
      });
    }

    const [picked] = pool.splice(bestSlot, 1);

    if (picked === undefined) break;

    const duplicates: Duplicate[] = [];

    for (let slot = pool.length - 1; slot >= 0; slot--) {
      const index = pool[slot]!;

      if (!foldable(picked, index)) continue;

      const duplicate: Duplicate = {
        id: ordered[index]!.row.id,
        title: ordered[index]!.row.title,
        score: round3(raw(picked, index)),
      };

      if (recordedPairs.has(keyOf(picked, index))) {
        duplicate.recorded = true;
      }

      duplicates.unshift(duplicate);
      pool.splice(slot, 1);
    }

    selected.push({ entry: ordered[picked]!, duplicates });

    if (useMmr) {
      for (const index of pool) {
        redundancy[index] = Math.max(redundancy[index]!, similarity(picked, index));
      }
    }
  }

  return selected;
}
