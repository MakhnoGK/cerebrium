import type { EvalQuery } from "@scripts/gold";

// A subset chosen by hashing the query text, not by shuffling: every arm must score the
// identical set, and a re-run days later must too, or two numbers stop being comparable.
export function sample(queries: EvalQuery[], size: number): EvalQuery[] {
  if (!Number.isFinite(size) || queries.length <= size) return queries;

  const hash = (s: string): number => {
    let h = 2166136261;

    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);

    return h >>> 0;
  };

  return [...queries].sort((a, b) => hash(a.query) - hash(b.query)).slice(0, size);
}

export function reciprocalRank(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (gold.has(ranked[i]!)) return 1 / (i + 1);
  }

  return 0;
}

export function ndcgAtK(ranked: string[], gold: Set<string>, k: number): number {
  let dcg = 0;

  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (gold.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }

  let idcg = 0;

  for (let i = 0; i < Math.min(k, gold.size); i++) idcg += 1 / Math.log2(i + 2);

  return idcg === 0 ? 0 : dcg / idcg;
}

export function precisionAt1(ranked: string[], gold: Set<string>): number {
  return ranked.length > 0 && gold.has(ranked[0]!) ? 1 : 0;
}

export function recallAtK(ranked: string[], gold: Set<string>, k: number): number {
  const top = new Set(ranked.slice(0, k));
  let hit = 0;

  for (const g of gold) if (top.has(g)) hit++;

  return gold.size === 0 ? 0 : hit / gold.size;
}
