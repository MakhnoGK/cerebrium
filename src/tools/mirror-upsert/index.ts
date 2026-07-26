import { ToolArgs, touchOrCreate } from "@/tools/context";
import { embeddingNotes } from "@/tools/notes";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/mirror-upsert/metadata";

@tool()
export class MirrorUpsertTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const source = this.ctx.repo.getSource(args.source_id);

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

    const result = this.ctx.repo.upsertMirrors(source, args.items, args.session_id, this.ctx.now());

    this.ctx.repo.logEvent(
      "mirror_upsert",
      args.session_id,
      null,
      {
        source_id: source.id,
        added: result.added,
        updated: result.updated,
        unchanged: result.unchanged,
      },
      this.ctx.now(),
    );

    const notes = embeddingNotes(this.ctx.repo);
    const out: Record<string, unknown> = { ...result };

    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }
}
