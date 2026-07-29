import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { EmbeddingService, HintsService } from "@/application/services";
import { MirrorRepo } from "@/db/repositories";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/mirror-upsert/metadata";

@tool()
export class MirrorUpsertTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly embeddings: EmbeddingService,
    private readonly mirror: MirrorRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);
    const source = this.mirror.getSource(args.source_id);

    if (!source) {
      throw new Error(
        `source '${args.source_id}' is not registered. Register it first with \`source_register\`.`,
      );
    }

    if (!source.enabled) {
      throw new Error(
        `source '${args.source_id}' is disabled. Re-enable it with \`source_register\` (enabled:true) before mirroring.`,
      );
    }

    const result = this.mirror.upsertMirrors(source, args.items, args.session_id, this.clock.now());
    const notes = this.embeddings.getEmbeddingNotes();
    const out: Record<string, unknown> = { ...result };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }
}
