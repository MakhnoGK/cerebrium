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
import { USE_RECORDER_TOKEN } from "@/domain/ports/use-recorder";
import "@/application/use-cases/local";
import {
  CHUNKS_REPO_TOKEN,
  CODE_REPO_TOKEN,
  CONSOLIDATION_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  EMBEDDING_QUEUE_REPO_TOKEN,
  JOBS_REPO_TOKEN,
  NODES_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  SESSIONS_REPO_TOKEN,
  STATS_REPO_TOKEN,
  type ChunksRepo,
  type CodeRepo,
  type ConsolidationRepo,
  type EdgesRepo,
  type EmbeddingQueueRepo,
  type JobsRepo,
  type NodesRepo,
  type SearchRepo,
  type SessionsRepo,
  type StatsRepo,
} from "@/domain/ports/storage";
import { PrincipalQuotaService } from "@/application/services";
import { EmbeddingWorker } from "@/application/workers";
import { DB_TOKEN } from "@/db/sqlite/base";
import { openDatabase } from "@/db/sqlite/database";
import { LocalNullProvider } from "@/embeddings/local-null";
import { ClientIdentity, UNKNOWN_WRITER } from "@/runtime/client-identity";
import { pipelinedContainer } from "@/runtime/pipelined-kernel";
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
  code: CodeRepo;
  consolidation: ConsolidationRepo;
  jobs: JobsRepo;
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
  container.register(USE_RECORDER_TOKEN, { useToken: NODES_REPO_TOKEN });

  // The identity holder outlives a container re-registration; without this a client named
  // by one test is still named in the next.
  container.resolve(ClientIdentity).set(UNKNOWN_WRITER);
  container.resolve(PrincipalQuotaService).reset();

  return {
    db,
    clock,
    provider,
    consolidator,
    worker: container.resolve(EmbeddingWorker),
    nodes: container.resolve<NodesRepo>(NODES_REPO_TOKEN),
    edges: container.resolve<EdgesRepo>(EDGES_REPO_TOKEN),
    search: container.resolve<SearchRepo>(SEARCH_REPO_TOKEN),
    chunks: container.resolve<ChunksRepo>(CHUNKS_REPO_TOKEN),
    code: container.resolve<CodeRepo>(CODE_REPO_TOKEN),
    consolidation: container.resolve<ConsolidationRepo>(CONSOLIDATION_REPO_TOKEN),
    jobs: container.resolve<JobsRepo>(JOBS_REPO_TOKEN),
    stats: container.resolve<StatsRepo>(STATS_REPO_TOKEN),
    queue: container.resolve<EmbeddingQueueRepo>(EMBEDDING_QUEUE_REPO_TOKEN),
    sessions: container.resolve<SessionsRepo>(SESSIONS_REPO_TOKEN),
  };
}

type ToolClass<Schema extends ZodRawShape, Response> = new (
  ...args: unknown[]
) => McpTool<Schema, Response>;

// Routes a call the way a host with no daemon does — the tool is rebuilt in a scope whose
// call surface runs through the pipeline, instead of `invoke` reaching the raw use cases.
// Use it when a test asserts on the `events` log or on principal policy.
export function callTool<Schema extends ZodRawShape, Response>(
  tool: McpTool<Schema, Response>,
  args: ToolArgs<Schema>,
): Promise<Response> {
  const scope = pipelinedContainer(container);
  const built = scope.resolve<McpTool<Schema, Response>>(
    tool.constructor as ToolClass<Schema, Response>,
  );

  return built.invoke(args);
}
