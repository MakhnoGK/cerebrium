import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { EmbeddingService, HintsService } from "@/application/services";
import { EdgesRepo, NodesRepo } from "@/db/repositories";
import { SYSTEM_EDGE_TYPES } from "@/core/vocab";
import { McpTool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { metadata } from "@/presentation/mcp/tools/link/metadata";

@tool()
export class LinkTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly embeddings: EmbeddingService,
    private readonly nodes: NodesRepo,
    private readonly edges: EdgesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getSessionHints(args.session_id);

    if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(args.type)) {
      throw new Error(
        `'${args.type}' edges are created by the system, not via link. Use another edge type.`,
      );
    }

    if (args.src === args.dst) throw new Error("cannot link a node to itself.");
    if (!(await this.nodes.exists(args.src)))
      throw new Error(`src node ${args.src} does not exist.`);
    if (!(await this.nodes.exists(args.dst)))
      throw new Error(`dst node ${args.dst} does not exist.`);

    const weight = args.weight ?? 1.0;

    this.edges.insertEdge(
      args.src,
      args.dst,
      args.type,
      "agent",
      args.session_id,
      this.clock.now(),
      weight,
    );

    const notes = this.embeddings.getEmbeddingNotes();
    const out: Record<string, unknown> = {
      ok: true,
      src: args.src,
      dst: args.dst,
      type: args.type,
      weight,
    };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }
}
