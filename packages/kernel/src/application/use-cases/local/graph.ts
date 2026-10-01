import { inject } from "tsyringe";
import type { GraphSnapshot } from "@cerebrium/contracts/graph";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { GRAPH_REPO_TOKEN, type GraphRepo } from "@/domain/ports/storage";
import {
  GRAPH_SNAPSHOT,
  useCase,
  type GraphSnapshotArgs,
  type GraphSnapshotUseCase,
} from "@/application/use-cases/contracts";

@useCase(GRAPH_SNAPSHOT)
export class LocalGraphSnapshot implements GraphSnapshotUseCase {
  constructor(
    @inject(GRAPH_REPO_TOKEN) private readonly graph: GraphRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: GraphSnapshotArgs): Promise<GraphSnapshot> {
    const generated_at = this.clock.now();
    const { nodes, edges } = await this.graph.snapshot({
      invalidated: args.invalidated === true,
      symbols: args.symbols === true,
    });

    return { generated_at, nodes, edges };
  }
}
