import "reflect-metadata";
import type pg from "pg";
import { container, type DependencyContainer } from "tsyringe";
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
  CONSOLIDATION_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  EMBEDDING_QUEUE_REPO_TOKEN,
  JOBS_REPO_TOKEN,
  NODES_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  SESSIONS_REPO_TOKEN,
  STATS_REPO_TOKEN,
  type ChunksRepo,
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
import { PG_TOKEN, type Params, type PgDatabase } from "@/db/postgres/database";
import { LocalNullProvider } from "@/embeddings/local-null";
import { ClientIdentity, UNKNOWN_WRITER } from "@/runtime/client-identity";
import { pipelinedContainer } from "@/runtime/pipelined-kernel";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { createConsolidator } from "@/consolidation";
import { freshPgDatabase } from "@test/pg";

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

// Raw SQL against the test's own database, with the repositories' `@name` parameters.
export interface TestSql {
  all<T extends pg.QueryResultRow>(sql: string, params?: Params): Promise<T[]>;
  one<T extends pg.QueryResultRow>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<number>;
}

export function sqlOf(db: PgDatabase): TestSql {
  return {
    all: async <T extends pg.QueryResultRow>(sql: string, params?: Params) =>
      (await db.query<T>(sql, params)).rows,
    one: async <T extends pg.QueryResultRow>(
      sql: string,
      params?: Params,
    ): Promise<T | undefined> => {
      const { rows } = await db.query<T>(sql, params);

      return rows[0];
    },
    run: async (sql, params) => (await db.query(sql, params)).rowCount ?? 0,
  };
}

export interface TestEnv {
  db: PgDatabase;
  sql: TestSql;
  clock: TestClock;
  worker: EmbeddingWorker;
  provider: EmbeddingProvider;
  consolidator: ConsolidationProvider;
  // Per-aggregate repositories (the composition root was removed).
  nodes: NodesRepo;
  edges: EdgesRepo;
  search: SearchRepo;
  chunks: ChunksRepo;
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
  const provider = opts?.provider ?? new LocalNullProvider();
  const db = freshPgDatabase(provider.name);
  const clock = makeClock(opts?.start ?? "2026-01-01T00:00:00.000Z");
  const consolidator = opts?.consolidator ?? createConsolidator("manual");

  container.register(PG_TOKEN, { useValue: db });
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
    sql: sqlOf(db),
    clock,
    provider,
    consolidator,
    worker: container.resolve(EmbeddingWorker),
    nodes: container.resolve<NodesRepo>(NODES_REPO_TOKEN),
    edges: container.resolve<EdgesRepo>(EDGES_REPO_TOKEN),
    search: container.resolve<SearchRepo>(SEARCH_REPO_TOKEN),
    chunks: container.resolve<ChunksRepo>(CHUNKS_REPO_TOKEN),
    consolidation: container.resolve<ConsolidationRepo>(CONSOLIDATION_REPO_TOKEN),
    jobs: container.resolve<JobsRepo>(JOBS_REPO_TOKEN),
    stats: container.resolve<StatsRepo>(STATS_REPO_TOKEN),
    queue: container.resolve<EmbeddingQueueRepo>(EMBEDDING_QUEUE_REPO_TOKEN),
    sessions: container.resolve<SessionsRepo>(SESSIONS_REPO_TOKEN),
  };
}

// A new, empty store for whatever resolves the kernel from `into`.
export function freshStore(into: DependencyContainer = container, spaceModel = "local-null"): void {
  into.register(PG_TOKEN, { useValue: freshPgDatabase(spaceModel) });
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
