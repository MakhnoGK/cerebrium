import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import {
  INVALIDATE_MEMORY,
  useCase,
  type EnvelopeResult,
  type InvalidateMemory,
  type InvalidateMemoryArgs,
} from "@/application/use-cases/contracts";

@useCase(INVALIDATE_MEMORY)
export class LocalInvalidateMemory implements InvalidateMemory {
  constructor(
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: InvalidateMemoryArgs): Promise<EnvelopeResult> {
    if (!(await this.nodes.exists(args.id))) throw new Error(`node ${args.id} does not exist.`);
    if (args.superseded_by && !(await this.nodes.exists(args.superseded_by))) {
      throw new Error(`superseded_by node ${args.superseded_by} does not exist.`);
    }

    // Code mirrors are maintained by the indexer; retiring one by hand would just come
    // back on the next re-index. External mirrors (origin != 'repo') are agent-curated,
    // so the agent legitimately retires a stale record here.
    const prov = await this.nodes.nodeOrigin(args.id);

    if (prov?.memory_kind === "mirror" && prov.origin === "repo") {
      throw new Error(
        "code symbols are maintained by the indexer, not invalidated by hand; run `code_index` to refresh them.",
      );
    }

    return {
      envelope: await this.nodes.invalidateNode(args.id, {
        ts: this.clock.now(),
        superseded_by: args.superseded_by,
        session_id: args.session_id,
      }),
    };
  }
}
