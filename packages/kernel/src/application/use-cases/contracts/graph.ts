import type { GraphQuery, GraphSnapshot } from "@cerebrium/contracts/graph";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

export interface GraphSnapshotArgs extends GraphQuery {
  session_id?: string;
}

// The whole authored graph in one read, for drawing it.
export type GraphSnapshotUseCase = UseCase<GraphSnapshotArgs, GraphSnapshot>;

export const GRAPH_SNAPSHOT = useCaseToken<GraphSnapshotArgs, GraphSnapshot>("GraphSnapshot");
