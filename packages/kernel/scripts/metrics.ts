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

// The mean paired difference b − a over the same queries, with a 95% band from resampling
// those queries. Seeded, so a re-run prints the same band.
export function pairedBootstrap(
  a: number[],
  b: number[],
  iterations = 2000,
  seed = 1,
): { delta: number; low: number; high: number } {
  if (a.length !== b.length) {
    throw new Error("pairedBootstrap needs one score per query in each arm");
  }

  if (a.length === 0) return { delta: NaN, low: NaN, high: NaN };

  const diffs = a.map((x, i) => b[i]! - x);
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    return state / 0x100000000;
  };
  const means: number[] = [];

  for (let it = 0; it < iterations; it++) {
    let sum = 0;

    for (let draws = diffs.length; draws > 0; draws--) {
      sum += diffs[Math.floor(next() * diffs.length)]!;
    }

    means.push(sum / diffs.length);
  }

  means.sort((x, y) => x - y);

  return {
    delta: diffs.reduce((s, d) => s + d, 0) / diffs.length,
    low: means[Math.floor(0.025 * iterations)]!,
    high: means[Math.ceil(0.975 * iterations) - 1]!,
  };
}

export function recallAtK(ranked: string[], gold: Set<string>, k: number): number {
  const top = new Set(ranked.slice(0, k));
  let hit = 0;

  for (const g of gold) if (top.has(g)) hit++;

  return gold.size === 0 ? 0 : hit / gold.size;
}
