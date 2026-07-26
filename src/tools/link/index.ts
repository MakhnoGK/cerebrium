import { ToolArgs, touchOrCreate } from "@/tools/context";
import { embeddingNotes } from "@/tools/notes";
import { SYSTEM_EDGE_TYPES } from "@/core/vocab";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/link/metadata";

@tool()
export class LinkTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);

    if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(args.type)) {
      throw new Error(
        `'${args.type}' edges are created by the system, not via link. Use another edge type.`,
      );
    }

    if (args.src === args.dst) throw new Error("cannot link a node to itself.");
    if (!this.ctx.repo.nodeExists(args.src))
      throw new Error(`src node ${args.src} does not exist.`);
    if (!this.ctx.repo.nodeExists(args.dst))
      throw new Error(`dst node ${args.dst} does not exist.`);

    const weight = args.weight ?? 1.0;

    this.ctx.repo.insertEdge(
      args.src,
      args.dst,
      args.type,
      "agent",
      args.session_id,
      this.ctx.now(),
      weight,
    );
    this.ctx.repo.logEvent(
      "link",
      args.session_id,
      args.src,
      { dst: args.dst, type: args.type, weight },
      this.ctx.now(),
    );

    const notes = embeddingNotes(this.ctx.repo);
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
