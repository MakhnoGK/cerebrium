import type BetterSqlite3 from "better-sqlite3";
import { openDatabase } from "@/db/database";
import { Repo } from "@/db/repo";
import { LocalNullProvider } from "@/embeddings/local-null";
import { EmbeddingWorker } from "@/embeddings/worker";
import type { EmbeddingProvider } from "@/embeddings/index";
import { createReranker } from "@/rerank/index";
import type { RerankProvider } from "@/rerank/index";
import { createConsolidator } from "@/consolidation/index";
import type { ConsolidationProvider } from "@/consolidation/index";
import type { Ctx } from "@/tools/context";

export interface Clock {
  t: string;
  advanceMs(ms: number): void;
  advanceDays(n: number): void;
}

export interface TestCtx {
  ctx: Ctx;
  clock: Clock;
  repo: Repo;
  provider: EmbeddingProvider;
  reranker: RerankProvider;
  consolidator: ConsolidationProvider;
  worker: EmbeddingWorker;
  db: BetterSqlite3.Database; // read-only inspection in tests
}

// In-memory DB + a mutable clock so ranking/decay is tested deterministically. The
// deterministic local-null provider keeps the suite offline; the worker is created
// but never auto-started — tests call worker.tick() to drain embeddings on demand.
export function makeCtx(opts?: {
  budget?: number;
  start?: string;
  provider?: EmbeddingProvider;
  reranker?: RerankProvider;
  consolidator?: ConsolidationProvider;
}): TestCtx {
  const db = openDatabase(":memory:");
  const repo = new Repo(db);
  const clock: Clock = {
    t: opts?.start ?? "2026-01-01T00:00:00.000Z",
    advanceMs(ms: number) {
      this.t = new Date(Date.parse(this.t) + ms).toISOString();
    },
    advanceDays(n: number) {
      this.advanceMs(n * 86_400_000);
    },
  };
  const provider = opts?.provider ?? new LocalNullProvider();
  const reranker = opts?.reranker ?? createReranker("off");
  const consolidator = opts?.consolidator ?? createConsolidator("manual");
  const now = () => clock.t;
  const ctx: Ctx = {
    repo,
    now,
    workingSetBudget: opts?.budget ?? 1500,
    provider,
    reranker,
    consolidator,
  };
  const worker = new EmbeddingWorker(repo, provider, now);
  return { ctx, clock, repo, provider, reranker, consolidator, worker, db };
}
