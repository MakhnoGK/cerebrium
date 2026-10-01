import { readFileSync } from "node:fs";
import { instanceCachingFactory, type DependencyContainer } from "tsyringe";
import {
  BRANCH_CODE_REPO_TOKEN,
  CHUNKS_REPO_TOKEN,
  CODE_REPO_TOKEN,
  CONSOLIDATION_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  EMBEDDING_QUEUE_REPO_TOKEN,
  GRAPH_REPO_TOKEN,
  JOBS_REPO_TOKEN,
  NODES_REPO_TOKEN,
  PRINCIPAL_TOKENS_REPO_TOKEN,
  PRINCIPALS_REPO_TOKEN,
  PROCESSES_REPO_TOKEN,
  REVIEWS_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  SESSIONS_REPO_TOKEN,
  STATS_REPO_TOKEN,
  STORE_TOKEN,
} from "@/domain/ports/storage";
import { PgBranchCodeRepo } from "@/db/postgres/branch-code";
import { PgChunksRepo } from "@/db/postgres/chunks";
import { PgCodeRepo } from "@/db/postgres/code";
import { PgConsolidationRepo } from "@/db/postgres/consolidation";
import { PG_TOKEN, PgDatabase } from "@/db/postgres/database";
import { PgEdgesRepo } from "@/db/postgres/edges";
import { PgEmbeddingQueueRepo } from "@/db/postgres/embedding-queue";
import { PgGraphRepo } from "@/db/postgres/graph";
import { PgJobsRepo } from "@/db/postgres/jobs";
import { PgNodesRepo } from "@/db/postgres/nodes";
import { PgPrincipalTokensRepo } from "@/db/postgres/principal-tokens";
import { PgPrincipalsRepo } from "@/db/postgres/principals";
import { PgProcessesRepo } from "@/db/postgres/processes";
import { PgReviewsRepo } from "@/db/postgres/reviews";
import { PgSearchRepo } from "@/db/postgres/search";
import { PgSessionsRepo } from "@/db/postgres/sessions";
import { PgStatsRepo } from "@/db/postgres/stats";
import { PgStore } from "@/db/postgres/store";
import { StorageConfig } from "@/infrastructure/config";

export { PG_TOKEN, PgDatabase } from "@/db/postgres/database";

export function postgresUrl(storage: StorageConfig): string {
  if (storage.postgresUrl) return storage.postgresUrl;

  if (storage.postgresUrlFile) return readFileSync(storage.postgresUrlFile, "utf8").trim();

  throw new Error(
    "storage.backend is postgres but neither MEMORY_PG_URL nor MEMORY_PG_URL_FILE is set",
  );
}

// The handle is lazy: nothing connects until a repository runs its first query.
export function registerPostgresRepositories(
  c: DependencyContainer,
  opts: { readOnly: boolean },
): void {
  c.register(PG_TOKEN, {
    useFactory: instanceCachingFactory((dc) => {
      const storage = dc.resolve(StorageConfig);

      return new PgDatabase({
        url: postgresUrl(storage),
        poolMax: storage.pgPoolMax,
        readOnly: opts.readOnly,
      });
    }),
  });
  c.register(CHUNKS_REPO_TOKEN, { useClass: PgChunksRepo });
  c.register(BRANCH_CODE_REPO_TOKEN, { useClass: PgBranchCodeRepo });
  c.register(CODE_REPO_TOKEN, { useClass: PgCodeRepo });
  c.register(CONSOLIDATION_REPO_TOKEN, { useClass: PgConsolidationRepo });
  c.register(EDGES_REPO_TOKEN, { useClass: PgEdgesRepo });
  c.register(EMBEDDING_QUEUE_REPO_TOKEN, { useClass: PgEmbeddingQueueRepo });
  c.register(GRAPH_REPO_TOKEN, { useClass: PgGraphRepo });
  c.register(JOBS_REPO_TOKEN, { useClass: PgJobsRepo });
  c.register(NODES_REPO_TOKEN, { useClass: PgNodesRepo });
  c.register(PRINCIPALS_REPO_TOKEN, { useClass: PgPrincipalsRepo });
  c.register(PRINCIPAL_TOKENS_REPO_TOKEN, { useClass: PgPrincipalTokensRepo });
  c.register(PROCESSES_REPO_TOKEN, { useClass: PgProcessesRepo });
  c.register(REVIEWS_REPO_TOKEN, { useClass: PgReviewsRepo });
  c.register(SEARCH_REPO_TOKEN, { useClass: PgSearchRepo });
  c.register(SESSIONS_REPO_TOKEN, { useClass: PgSessionsRepo });
  c.register(STATS_REPO_TOKEN, { useClass: PgStatsRepo });
  c.register(STORE_TOKEN, { useClass: PgStore });
}
