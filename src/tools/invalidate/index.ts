import { ToolArgs, touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/invalidate/metadata";

@tool()
export class InvalidateTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);

    if (!this.ctx.repo.nodeExists(args.id)) throw new Error(`node ${args.id} does not exist.`);
    if (args.superseded_by && !this.ctx.repo.nodeExists(args.superseded_by)) {
      throw new Error(`superseded_by node ${args.superseded_by} does not exist.`);
    }

    // Code mirrors are maintained by the indexer; retiring one by hand would just come
    // back on the next re-index. External mirrors (origin != 'repo') are agent-curated,
    // so the agent legitimately retires a stale record here.
    const prov = this.ctx.repo.nodeOrigin(args.id);

    if (prov?.memory_kind === "mirror" && prov.origin === "repo") {
      throw new Error(
        "code symbols are maintained by the indexer, not invalidated by hand; run `code_index` to refresh them.",
      );
    }

    const envelope = this.ctx.repo.invalidateNode(args.id, {
      ts: this.ctx.now(),
      superseded_by: args.superseded_by,
      session_id: args.session_id,
    });

    this.ctx.repo.logEvent(
      "invalidate",
      args.session_id,
      args.id,
      { reason: args.reason, superseded_by: args.superseded_by ?? null },
      this.ctx.now(),
    );

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
