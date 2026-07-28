import { inject } from "tsyringe";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";
import { metadata } from "@/tools/update/metadata";
import { NodesRepo } from "@/db/repositories";
import { HintsService } from "@/tools/services/hints.service";
import { CLOCK_TOKEN, Clock } from "@/tools/services/clock.service";

const MAX_CONTENT = 50_000;

@tool()
export class UpdateTool implements McpTool<(typeof metadata)["schema"], unknown> {
  public getMetadata = () => metadata;

  constructor(
    private readonly hints: HintsService,
    private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: ToolArgs<(typeof metadata)["schema"]>): Promise<unknown> {
    const hints = await this.hints.getUnknownSessionHints(args.session_id, null);
    const current = this.nodes.envelope(args.id);

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

    const envelope = this.nodes.addRevision(args.id, {
      content: args.content,
      title: args.title,
      session_id: args.session_id,
      reason: args.reason ?? null,
      ts: this.clock.now(),
    });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
