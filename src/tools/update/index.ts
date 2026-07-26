import { ToolArgs, touchOrCreate } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/update/metadata";

const MAX_CONTENT = 50_000;

@tool()
export class UpdateTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = touchOrCreate(this.ctx, args.session_id);
    const current = this.ctx.repo.envelope(args.id);

    if (!current) throw new Error(`node ${args.id} does not exist.`);
    if (current.kind === "episodic") {
      throw new Error("episodic memories are write-once; write a new node.");
    }

    if (current.kind === "mirror") {
      throw new Error(
        "symbol/mirror nodes are re-indexed, not hand-edited; run `code_index` to refresh them. To record insight ABOUT " +
          "this code, write a semantic node and `link` it with a 'documents' edge.",
      );
    }

    if (args.content === undefined && args.title === undefined) {
      throw new Error("nothing to update — provide `content` and/or `title`.");
    }

    if (args.content !== undefined && args.content.length > MAX_CONTENT) {
      throw new Error(
        `content is ${args.content.length} chars; the limit is ${MAX_CONTENT}. Split this into smaller linked notes.`,
      );
    }

    const envelope = this.ctx.repo.addRevision(args.id, {
      content: args.content,
      title: args.title,
      session_id: args.session_id,
      reason: args.reason ?? null,
      ts: this.ctx.now(),
    });

    this.ctx.repo.logEvent(
      "update",
      args.session_id,
      args.id,
      { rev: envelope.rev, reason: args.reason ?? null },
      this.ctx.now(),
    );

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
