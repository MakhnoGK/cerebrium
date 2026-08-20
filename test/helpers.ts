import "reflect-metadata";
import type BetterSqlite3 from "better-sqlite3";
import { container } from "tsyringe";
import { ZodRawShape } from "zod";
import { Clock, CLOCK_TOKEN } from "@/domain/ports/clock";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  type ConsolidationProvider,
} from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN, EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { RECORD_EVENTS, type RecordEvents } from "@/application/use-cases";
import "@/application/use-cases/local";
import { EmbeddingWorker } from "@/application/workers";
import { openDatabase } from "@/db/database";
import {
  ChunksRepo,
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
import { DB_TOKEN } from "@/db/repositories/base";
import { LocalNullProvider } from "@/embeddings/local-null";
import { ClientIdentity, UNKNOWN_WRITER } from "@/runtime/client-identity";
import { AuditedTool } from "@/presentation/mcp/adapters";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { createConsolidator } from "@/consolidation";

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
  consolidator: ConsolidationProvider;
  // Per-aggregate repositories (the composition root was removed).
  nodes: NodesRepo;
  edges: EdgesRepo;
  search: SearchRepo;
  chunks: ChunksRepo;
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
  consolidator?: ConsolidationProvider;
}): TestEnv {
  const db = openDatabase(":memory:");
  const clock = makeClock(opts?.start ?? "2026-01-01T00:00:00.000Z");
  const provider = opts?.provider ?? new LocalNullProvider();
  const consolidator = opts?.consolidator ?? createConsolidator("manual");

  container.register(DB_TOKEN, { useValue: db });
  container.register(CLOCK_TOKEN, { useValue: clock });
  container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: provider });
  container.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: consolidator });

  // The identity holder outlives a container re-registration; without this a client named
  // by one test is still named in the next.
  container.resolve(ClientIdentity).set(UNKNOWN_WRITER);

  return {
    db,
    clock,
    provider,
    consolidator,
    worker: container.resolve(EmbeddingWorker),
    nodes: container.resolve(NodesRepo),
    edges: container.resolve(EdgesRepo),
    search: container.resolve(SearchRepo),
    chunks: container.resolve(ChunksRepo),
    mirror: container.resolve(MirrorRepo),
    code: container.resolve(CodeRepo),
    consolidation: container.resolve(ConsolidationRepo),
    stats: container.resolve(StatsRepo),
    queue: container.resolve(EmbeddingQueueRepo),
    sessions: container.resolve(SessionsRepo),
  };
}

// Routes a call through the audit boundary the server composes, instead of straight
// into `invoke` — use it when a test asserts on the `events` log.
export function callTool<Schema extends ZodRawShape, Response>(
  tool: McpTool<Schema, Response>,
  args: ToolArgs<Schema>,
): Promise<Response> {
  return new AuditedTool(tool, container.resolve<RecordEvents>(RECORD_EVENTS)).invoke(args);
}
