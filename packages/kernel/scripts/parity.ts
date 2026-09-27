import type { EvalQuery } from "@scripts/gold";
import { ndcgAtK, recallAtK } from "@scripts/metrics";
import type { DependencyContainer } from "tsyringe";
import type { MemoryKind } from "@cerebrium/contracts/vocab";
import { EmbeddingRole, type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { SEARCH_REPO_TOKEN, type SearchRepo } from "@/domain/ports/storage";
import { SEARCH_MEMORY, type SearchMemory } from "@/application/use-cases";

// Two stores holding the same memory (a SQLite file and its Postgres import), measured
// side by side on the same queries and the same query vectors.

export const K = 10;
const VECTOR_TOP = 40;

export interface ParityInput {
  sqlite: DependencyContainer;
  pg: DependencyContainer;
  provider: EmbeddingProvider;
  queries: EvalQuery[];
  kinds: MemoryKind[];
  // Node pairs whose similarity a gate decides, and the gates to hold them against.
  pairs: [string, string][];
  gates: Record<string, number>;
}

export interface BranchScores {
  sqlite: { ndcg: number; recall: number; p50: number; p95: number };
  pg: { ndcg: number; recall: number; p50: number; p95: number };
  // Queries PG scores lower on, worst first.
  lost: { query: string; sqlite: number; pg: number }[];
}

export interface ParityReport {
  queries: number;
  vector: {
    meanJaccard: number;
    minJaccard: number;
    maxDistanceDelta: number;
    below: { query: string; jaccard: number }[];
    p50: { sqlite: number; pg: number };
  };
  text: BranchScores;
  hybrid: BranchScores;
  gates: {
    pairs: number;
    compared: number;
    maxDelta: number;
    flips: { a: string; b: string; gate: string; sqlite: number; pg: number }[];
  };
}

export interface ParityRules {
  minJaccard: number;
  maxDistanceDelta: number;
  // How many points of nDCG@10 or Recall@10 PG may trail SQLite by.
  maxWorse: number;
}

export const DEFAULT_RULES: ParityRules = {
  minJaccard: 0.98,
  maxDistanceDelta: 1e-5,
  maxWorse: 1.0,
};

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;

  const sorted = [...xs].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }

  return dot / Math.sqrt(na * nb);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();

  return { value, ms: performance.now() - started };
}

async function branch(
  input: ParityInput,
  mode: "text" | "hybrid",
  vectors: Map<string, number[]>,
): Promise<BranchScores> {
  const run = async (scope: DependencyContainer) => {
    const search = scope.resolve<SearchMemory>(SEARCH_MEMORY);
    const ndcg: number[] = [];
    const recall: number[] = [];
    const ms: number[] = [];

    for (const q of input.queries) {
      const { value, ms: took } = await timed(() =>
        search.invoke({
          query: q.query,
          limit: K,
          mode,
          kinds: input.kinds,
          ...(mode === "hybrid" ? { query_vector: vectors.get(q.query) } : {}),
        }),
      );
      const ranked = value.results.map((r) => r.id);

      ndcg.push(ndcgAtK(ranked, q.gold, K));
      recall.push(recallAtK(ranked, q.gold, K));
      ms.push(took);
    }

    return { ndcg, recall, ms };
  };

  const s = await run(input.sqlite);
  const p = await run(input.pg);
  const lost = input.queries
    .map((q, i) => ({ query: q.query, sqlite: s.ndcg[i]!, pg: p.ndcg[i]! }))
    .filter((r) => r.pg < r.sqlite)
    .sort((a, b) => b.sqlite - b.pg - (a.sqlite - a.pg));

  const side = (r: { ndcg: number[]; recall: number[]; ms: number[] }) => ({
    ndcg: mean(r.ndcg) * 100,
    recall: mean(r.recall) * 100,
    p50: percentile(r.ms, 50),
    p95: percentile(r.ms, 95),
  });

  return { sqlite: side(s), pg: side(p), lost };
}

export async function measureParity(input: ParityInput): Promise<ParityReport> {
  const vectors = new Map<string, number[]>();

  for (const q of input.queries) {
    const [v] = await input.provider.embed([q.query], EmbeddingRole.QUERY);

    vectors.set(q.query, v!);
  }

  const sqliteSearch = input.sqlite.resolve<SearchRepo>(SEARCH_REPO_TOKEN);
  const pgSearch = input.pg.resolve<SearchRepo>(SEARCH_REPO_TOKEN);
  const jaccards: number[] = [];
  const below: { query: string; jaccard: number }[] = [];
  const vms = { sqlite: [] as number[], pg: [] as number[] };
  let maxDistanceDelta = 0;

  for (const q of input.queries) {
    const filters = { kinds: input.kinds, history: false, cap: VECTOR_TOP };
    const a = await timed(() => sqliteSearch.vectorSearch(vectors.get(q.query)!, filters));
    const b = await timed(() => pgSearch.vectorSearch(vectors.get(q.query)!, filters));
    const left = new Map(a.value.map((r) => [r.id, r.distance]));
    const right = new Map(b.value.map((r) => [r.id, r.distance]));
    const union = new Set([...left.keys(), ...right.keys()]);
    const shared = [...left.keys()].filter((id) => right.has(id));
    const jaccard = union.size ? shared.length / union.size : 1;

    for (const id of shared) {
      maxDistanceDelta = Math.max(maxDistanceDelta, Math.abs(left.get(id)! - right.get(id)!));
    }

    jaccards.push(jaccard);
    vms.sqlite.push(a.ms);
    vms.pg.push(b.ms);

    if (jaccard < DEFAULT_RULES.minJaccard) below.push({ query: q.query, jaccard });
  }

  const ids = [...new Set(input.pairs.flat())];
  const sv = await sqliteSearch.vectorsFor(ids);
  const pv = await pgSearch.vectorsFor(ids);
  const flips: ParityReport["gates"]["flips"] = [];
  let compared = 0;
  let maxDelta = 0;

  for (const [a, b] of input.pairs) {
    const [sa, sb, pa, pb] = [sv.get(a), sv.get(b), pv.get(a), pv.get(b)];

    if (!sa || !sb || !pa || !pb) continue;

    const s = cosine(sa, sb);
    const p = cosine(pa, pb);

    compared++;
    maxDelta = Math.max(maxDelta, Math.abs(s - p));

    for (const [gate, threshold] of Object.entries(input.gates)) {
      if (s >= threshold !== p >= threshold) flips.push({ a, b, gate, sqlite: s, pg: p });
    }
  }

  return {
    queries: input.queries.length,
    vector: {
      meanJaccard: mean(jaccards),
      minJaccard: jaccards.length ? Math.min(...jaccards) : 1,
      maxDistanceDelta,
      below,
      p50: { sqlite: percentile(vms.sqlite, 50), pg: percentile(vms.pg, 50) },
    },
    text: await branch(input, "text", vectors),
    hybrid: await branch(input, "hybrid", vectors),
    gates: { pairs: input.pairs.length, compared, maxDelta, flips },
  };
}

// Empty when the Postgres store may replace the SQLite one.
export function parityFailures(report: ParityReport, rules = DEFAULT_RULES): string[] {
  const failures: string[] = [];

  if (report.vector.minJaccard < rules.minJaccard) {
    failures.push(
      `vector top-${String(VECTOR_TOP)} overlap fell to ${report.vector.minJaccard.toFixed(3)} on ${String(report.vector.below.length)} queries (floor ${String(rules.minJaccard)})`,
    );
  }

  if (report.vector.maxDistanceDelta >= rules.maxDistanceDelta) {
    failures.push(
      `a shared neighbour's distance differs by ${report.vector.maxDistanceDelta.toExponential(2)} (limit ${rules.maxDistanceDelta.toExponential(0)})`,
    );
  }

  for (const [name, scores] of [
    ["text", report.text],
    ["hybrid", report.hybrid],
  ] as const) {
    for (const metric of ["ndcg", "recall"] as const) {
      const delta = scores.pg[metric] - scores.sqlite[metric];

      if (delta < -rules.maxWorse) {
        failures.push(
          `${name} ${metric} is ${delta.toFixed(1)} points behind SQLite (allowed ${String(-rules.maxWorse)})`,
        );
      }
    }
  }

  if (report.gates.flips.length) {
    failures.push(
      `${String(report.gates.flips.length)} merge pairs land on the other side of a similarity gate`,
    );
  }

  return failures;
}
