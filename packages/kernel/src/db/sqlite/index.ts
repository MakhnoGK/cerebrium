import type { DependencyContainer } from "tsyringe";
import {
  BRANCH_CODE_REPO_TOKEN,
  CHUNKS_REPO_TOKEN,
  CODE_REPO_TOKEN,
  CONSOLIDATION_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  EMBEDDING_QUEUE_REPO_TOKEN,
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
import { SqliteBranchCodeRepo } from "@/db/sqlite/branch-code";
import { SqliteChunksRepo } from "@/db/sqlite/chunks";
import { SqliteCodeRepo } from "@/db/sqlite/code";
import { SqliteConsolidationRepo } from "@/db/sqlite/consolidation";
import { SqliteEdgesRepo } from "@/db/sqlite/edges";
import { SqliteEmbeddingQueueRepo } from "@/db/sqlite/embedding-queue";
import { SqliteJobsRepo } from "@/db/sqlite/jobs";
import { SqliteNodesRepo } from "@/db/sqlite/nodes";
import { SqlitePrincipalTokensRepo } from "@/db/sqlite/principal-tokens";
import { SqlitePrincipalsRepo } from "@/db/sqlite/principals";
import { SqliteProcessesRepo } from "@/db/sqlite/processes";
import { SqliteReviewsRepo } from "@/db/sqlite/reviews";
import { SqliteSearchRepo } from "@/db/sqlite/search";
import { SqliteSessionsRepo } from "@/db/sqlite/sessions";
import { SqliteStatsRepo } from "@/db/sqlite/stats";
import { SqliteStore } from "@/db/sqlite/store";

export { BaseRepo, DB_TOKEN } from "@/db/sqlite/base";
export {
  SqliteChunksRepo,
  SqliteCodeRepo,
  SqliteConsolidationRepo,
  SqliteEdgesRepo,
  SqliteEmbeddingQueueRepo,
  SqliteJobsRepo,
  SqliteNodesRepo,
  SqlitePrincipalTokensRepo,
  SqlitePrincipalsRepo,
  SqliteProcessesRepo,
  SqliteReviewsRepo,
  SqliteSearchRepo,
  SqliteSessionsRepo,
  SqliteStatsRepo,
  SqliteStore,
};

export function registerSqliteRepositories(c: DependencyContainer): void {
  c.register(CHUNKS_REPO_TOKEN, { useClass: SqliteChunksRepo });
  c.register(BRANCH_CODE_REPO_TOKEN, { useClass: SqliteBranchCodeRepo });
  c.register(CODE_REPO_TOKEN, { useClass: SqliteCodeRepo });
  c.register(CONSOLIDATION_REPO_TOKEN, { useClass: SqliteConsolidationRepo });
  c.register(EDGES_REPO_TOKEN, { useClass: SqliteEdgesRepo });
  c.register(EMBEDDING_QUEUE_REPO_TOKEN, { useClass: SqliteEmbeddingQueueRepo });
  c.register(JOBS_REPO_TOKEN, { useClass: SqliteJobsRepo });
  c.register(NODES_REPO_TOKEN, { useClass: SqliteNodesRepo });
  c.register(PRINCIPALS_REPO_TOKEN, { useClass: SqlitePrincipalsRepo });
  c.register(PRINCIPAL_TOKENS_REPO_TOKEN, { useClass: SqlitePrincipalTokensRepo });
  c.register(PROCESSES_REPO_TOKEN, { useClass: SqliteProcessesRepo });
  c.register(REVIEWS_REPO_TOKEN, { useClass: SqliteReviewsRepo });
  c.register(SEARCH_REPO_TOKEN, { useClass: SqliteSearchRepo });
  c.register(SESSIONS_REPO_TOKEN, { useClass: SqliteSessionsRepo });
  c.register(STATS_REPO_TOKEN, { useClass: SqliteStatsRepo });
  c.register(STORE_TOKEN, { useClass: SqliteStore });
}
