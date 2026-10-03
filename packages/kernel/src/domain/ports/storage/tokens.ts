import { BRANCH_CODE_REPO_TOKEN } from "@/domain/ports/storage/branch-code";
import { CHUNKS_REPO_TOKEN } from "@/domain/ports/storage/chunks";
import { CODE_REPO_TOKEN } from "@/domain/ports/storage/code";
import { CONSOLIDATION_REPO_TOKEN } from "@/domain/ports/storage/consolidation";
import { EDGES_REPO_TOKEN } from "@/domain/ports/storage/edges";
import { EMBEDDING_QUEUE_REPO_TOKEN } from "@/domain/ports/storage/embedding-queue";
import { GRAPH_REPO_TOKEN } from "@/domain/ports/storage/graph";
import { JOBS_REPO_TOKEN } from "@/domain/ports/storage/jobs";
import { NODES_REPO_TOKEN } from "@/domain/ports/storage/nodes";
import { PRINCIPAL_TOKENS_REPO_TOKEN } from "@/domain/ports/storage/principal-tokens";
import { PRINCIPALS_REPO_TOKEN } from "@/domain/ports/storage/principals";
import { PROCESSES_REPO_TOKEN } from "@/domain/ports/storage/processes";
import { REVIEWS_REPO_TOKEN } from "@/domain/ports/storage/reviews";
import { SEARCH_REPO_TOKEN } from "@/domain/ports/storage/search";
import { SESSIONS_REPO_TOKEN } from "@/domain/ports/storage/sessions";
import { STATS_REPO_TOKEN } from "@/domain/ports/storage/stats";
import { STORE_TOKEN } from "@/domain/ports/storage/store";
import { VECTOR_SPACES_REPO_TOKEN } from "@/domain/ports/storage/vector-spaces";

// Every storage port a backend has to bind.
export const STORAGE_TOKENS = {
  branchCodeRepo: BRANCH_CODE_REPO_TOKEN,
  chunksRepo: CHUNKS_REPO_TOKEN,
  codeRepo: CODE_REPO_TOKEN,
  consolidationRepo: CONSOLIDATION_REPO_TOKEN,
  edgesRepo: EDGES_REPO_TOKEN,
  embeddingQueueRepo: EMBEDDING_QUEUE_REPO_TOKEN,
  graphRepo: GRAPH_REPO_TOKEN,
  jobsRepo: JOBS_REPO_TOKEN,
  nodesRepo: NODES_REPO_TOKEN,
  principalsRepo: PRINCIPALS_REPO_TOKEN,
  principalTokensRepo: PRINCIPAL_TOKENS_REPO_TOKEN,
  processesRepo: PROCESSES_REPO_TOKEN,
  reviewsRepo: REVIEWS_REPO_TOKEN,
  searchRepo: SEARCH_REPO_TOKEN,
  sessionsRepo: SESSIONS_REPO_TOKEN,
  statsRepo: STATS_REPO_TOKEN,
  store: STORE_TOKEN,
  vectorSpacesRepo: VECTOR_SPACES_REPO_TOKEN,
} as const;
