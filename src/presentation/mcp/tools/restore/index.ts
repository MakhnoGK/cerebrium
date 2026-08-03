import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { HintsService } from "@/application/services";
import { NodesRepo } from "@/db/repositories";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/restore/metadata";

@tool()
export class RestoreTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);

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

    const envelope = this.nodes.envelope(args.id)!;

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
