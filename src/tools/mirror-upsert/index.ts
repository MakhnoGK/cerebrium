import { inject } from "tsyringe";
import { Clock, CLOCK_TOKEN } from "@/domain/ports/clock";
import { MirrorRepo } from "@/db/repositories";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/mirror-upsert/metadata";
import { EmbeddingService } from "@/tools/services/embedding.service";
import { HintsService } from "@/tools/services/hints.service";

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
