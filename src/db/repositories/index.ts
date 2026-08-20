// Public entry for the per-aggregate repositories. Consumers (the Repo composition
// root) import from here; repositories import each other by direct path to avoid
// import cycles through this barrel.
export { BaseRepo } from "@/db/repositories/base";
export { SessionsRepo } from "@/db/repositories/sessions";
export { EdgesRepo } from "@/db/repositories/edges";
export { NodesRepo } from "@/db/repositories/nodes";
export { PrincipalsRepo, type PrincipalRow } from "@/db/repositories/principals";
export { EmbeddingQueueRepo } from "@/db/repositories/embedding-queue";
export { SearchRepo } from "@/db/repositories/search";
export { ChunksRepo } from "@/db/repositories/chunks";
export { CodeRepo } from "@/db/repositories/code";
export { MirrorRepo } from "@/db/repositories/mirror";
export { ConsolidationRepo } from "@/db/repositories/consolidation";
export { ProcessesRepo, type ProcessRow } from "@/db/repositories/processes";
export { StatsRepo } from "@/db/repositories/stats";
