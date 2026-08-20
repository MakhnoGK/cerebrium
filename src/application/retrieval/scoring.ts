import { DECAY_DAYS, USE_SATURATION } from "@/application/retrieval/constants";
import type { Entry } from "@/application/retrieval/types";
import type { EnrichedRow } from "@/core/types";
import { MemoryKind } from "@/core/vocab";

export function byScore(a: Entry, b: Entry): number {
  return (
    b.score - a.score ||
    b.row.updated.localeCompare(a.row.updated) ||
    a.row.id.localeCompare(b.row.id)
  );
}

// Min-max to [0,1]; a set with no spread is all-1 so the term stops discriminating
// instead of amplifying float noise.
export function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const spread = Math.max(...values) - min;

  return values.map((v) => (spread > 0 ? (v - min) / spread : 1));
}

// Candidate-set similarity, min-max normalized over the pairs that exist. A pair where
// either side has no stored vector reads 0 — absent, not dissimilar.
export function pairwise(
  entries: Entry[],
  vectors: Map<string, Float32Array>,
): (a: number, b: number) => number {
  const n = entries.length;
  const slots = entries.map((e) => vectors.get(e.row.id));
  const sims = new Float64Array(n * n);
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i++) {
    const left = slots[i];

    if (!left) continue;

    for (let j = i + 1; j < n; j++) {
      const right = slots[j];

      if (!right) continue;

      const sim = cosine(left, right);

      sims[i * n + j] = sim;
      sims[j * n + i] = sim;

      if (sim < min) min = sim;
      if (sim > max) max = sim;
    }
  }

  const spread = max - min;

  return (a, b) => {
    if (!slots[a] || !slots[b]) return 0;

    return spread > 0 ? (sims[a * n + b]! - min) / spread : 0;
  };
}

// Raw cosine, in contrast to `pairwise`, which min-max normalizes within the result set.
// A normalized score is fine for MMR's relative penalty and meaningless against an
// absolute gate — the top pair of any set normalizes to 1.0 however unalike it is.
export function rawSimilarity(
  entries: Entry[],
  vectors: Map<string, Float32Array>,
): (a: number, b: number) => number {
  const slots = entries.map((e) => vectors.get(e.row.id));

  return (a, b) => {
    const left = slots[a];
    const right = slots[b];

    return left && right ? cosine(left, right) : 0;
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;

    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// Episodic relevance decays by DISUSE, not wall-clock age: the clock restarts every time
// an agent actually fetches the node, so a checkpoint that keeps earning its retrieval
// stays reachable while an untouched one still falls away.
export function memoryFactor(row: EnrichedRow, now: number, history: boolean): number {
  if (history || row.memory_kind !== MemoryKind.EPISODIC) {
    return 1; // history queries drop episodic decay (superseded nodes included, flagged)
  }

  const touched = Math.max(Date.parse(row.valid_from), Date.parse(row.last_used_at ?? "") || 0);
  const ageDays = Math.max(0, (now - touched) / 86_400_000);

  return Math.exp(-ageDays / DECAY_DAYS);
}

// Importance prior: log-scaled in the number of fetches and hard-capped at 1 + weight, so
// a hot node tilts a close call but can never outrank on popularity alone. Exported for the
// cap's own test: the ceiling is a numeric property, and on a real corpus the base score gap
// between two candidates is smaller than the boost itself, so search order cannot see it.
export function strengthFactor(row: EnrichedRow, weight: number): number {
  if (weight <= 0 || row.use_count <= 0) {
    return 1;
  }

  return 1 + weight * Math.min(1, Math.log1p(row.use_count) / Math.log1p(USE_SATURATION));
}

export function symbolFactor(row: EnrichedRow, penalty: number): number {
  return row.type === "symbol" ? penalty : 1;
}
