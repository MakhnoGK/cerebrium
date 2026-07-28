import "reflect-metadata";
import type BetterSqlite3 from "better-sqlite3";
import { container } from "tsyringe";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import {
  CodeRepo,
  ConsolidationRepo,
  EdgesRepo,
  EmbeddingQueueRepo,
  MirrorRepo,
  NodesRepo,
  SearchRepo,
  SessionsRepo,
  StatsRepo,
} from "@/db/repositories";
import { LocalNullProvider } from "@/embeddings/local-null";
import { EmbeddingWorker } from "@/embeddings/worker";
import { EMBEDDING_PROVIDER_TOKEN, EmbeddingProvider } from "@/embeddings";
import { createReranker, RERANK_PROVIDER_TOKEN, RerankProvider } from "@/rerank";
import { createConsolidator, ConsolidationProvider } from "@/consolidation";
import { CONSOLIDATOR_TOKEN } from "@/tools/services/consolidation.service";
import { CLOCK_TOKEN, Clock } from "@/tools/services/clock.service";

export interface TestClock extends Clock {
  t: string;
  advanceMs(ms: number): void;
  advanceDays(n: number): void;
}

function makeClock(start: string): TestClock {
  return {
    t: start,
    now() {
      return this.t;
    },
    advanceMs(ms: number) {
      this.t = new Date(Date.parse(this.t) + ms).toISOString();
    },
    advanceDays(n: number) {
      this.advanceMs(n * 86_400_000);
    },
  };
}

export interface TestEnv {
  db: BetterSqlite3.Database;
  clock: TestClock;
  worker: EmbeddingWorker;
  provider: EmbeddingProvider;
  reranker: RerankProvider;
  consolidator: ConsolidationProvider;
  // Per-aggregate repositories (the composition root was removed).
  nodes: NodesRepo;
  edges: EdgesRepo;
  search: SearchRepo;
  mirror: MirrorRepo;
  code: CodeRepo;
  consolidation: ConsolidationRepo;
  stats: StatsRepo;
  queue: EmbeddingQueueRepo;
  sessions: SessionsRepo;
}

export function setup(opts?: {
  start?: string;
  provider?: EmbeddingProvider;
  reranker?: RerankProvider;
  consolidator?: ConsolidationProvider;
}): TestEnv {
  const db = openDatabase(":memory:");
  const clock = makeClock(opts?.start ?? "2026-01-01T00:00:00.000Z");
  const provider = opts?.provider ?? new LocalNullProvider();
  const reranker = opts?.reranker ?? createReranker("off");
  const consolidator = opts?.consolidator ?? createConsolidator("manual");

  container.register(DB_TOKEN, { useValue: db });
  container.register(CLOCK_TOKEN, { useValue: clock });
  container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: provider });
  container.register(RERANK_PROVIDER_TOKEN, { useValue: reranker });
  container.register(CONSOLIDATOR_TOKEN, { useValue: consolidator });

  return {
    db,
    clock,
    provider,
    reranker,
    consolidator,
    worker: container.resolve(EmbeddingWorker),
    nodes: container.resolve(NodesRepo),
    edges: container.resolve(EdgesRepo),
    search: container.resolve(SearchRepo),
    mirror: container.resolve(MirrorRepo),
    code: container.resolve(CodeRepo),
    consolidation: container.resolve(ConsolidationRepo),
    stats: container.resolve(StatsRepo),
    queue: container.resolve(EmbeddingQueueRepo),
    sessions: container.resolve(SessionsRepo),
  };
}
