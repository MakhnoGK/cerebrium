import { inject } from "tsyringe";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/invalidate/metadata";
import { NodesRepo } from "@/db/repositories";
import { HintsService } from "@/tools/services/hints.service";
import { CLOCK_TOKEN, Clock } from "@/tools/services/clock.service";

@tool()
export class InvalidateTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);

    if (!(await this.nodes.exists(args.id))) throw new Error(`node ${args.id} does not exist.`);
    if (args.superseded_by && !(await this.nodes.exists(args.superseded_by))) {
      throw new Error(`superseded_by node ${args.superseded_by} does not exist.`);
    }

    // Code mirrors are maintained by the indexer; retiring one by hand would just come
    // back on the next re-index. External mirrors (origin != 'repo') are agent-curated,
    // so the agent legitimately retires a stale record here.
    const prov = this.nodes.nodeOrigin(args.id);

    if (prov?.memory_kind === "mirror" && prov.origin === "repo") {
      throw new Error(
        "code symbols are maintained by the indexer, not invalidated by hand; run `code_index` to refresh them.",
      );
    }

    const envelope = this.nodes.invalidateNode(args.id, {
      ts: this.clock.now(),
      superseded_by: args.superseded_by,
      session_id: args.session_id,
    });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
