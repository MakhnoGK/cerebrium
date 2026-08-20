import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  RESTORE_MEMORY,
  useCase,
  type EnvelopeResult,
  type RestoreMemory,
  type RestoreMemoryArgs,
} from "@/application/use-cases/contracts";
import { NodesRepo } from "@/db/repositories";

@useCase(RESTORE_MEMORY)
export class LocalRestoreMemory implements RestoreMemory {
  constructor(
    private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: RestoreMemoryArgs): Promise<EnvelopeResult> {
    if (!(await this.nodes.exists(args.id))) throw new Error(`node ${args.id} does not exist.`);

    const prov = this.nodes.nodeOrigin(args.id);

    if (prov?.memory_kind === "mirror" && prov.origin === "repo") {
      throw new Error(
        "code symbols are maintained by the indexer, not restored by hand; run `code_index` to refresh them.",
      );
    }

    const restored = this.nodes.restoreNode(args.id, {
      ts: this.clock.now(),
      session_id: args.session_id,
    });

    if (!restored) {
      throw new Error(
        `node ${args.id} is not invalidated, so there is nothing to restore; use \`get\` to read it.`,
      );
    }

    return { envelope: this.nodes.envelope(args.id)! };
  }
}
