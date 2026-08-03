import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { HintsService } from "@/application/services";
import { NodesRepo } from "@/db/repositories";
import { MemoryKind } from "@/core/vocab";
import { McpTool, tool, ToolArgs } from "@/presentation/mcp/tools/contracts";
import { metadata } from "@/presentation/mcp/tools/update/metadata";

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
    if (current.kind === MemoryKind.EPISODIC) {
      throw new Error("episodic memories are write-once; write a new node.");
    }

    if (current.kind === MemoryKind.MIRROR) {
      throw new Error(
        "symbol/mirror nodes are re-indexed, not hand-edited; run `code_index` to refresh them. To record insight ABOUT " +
          "this code, write a semantic node and `link` it with a 'documents' edge.",
      );
    }

    const window = { event_from: args.event_from, event_to: args.event_to };
    const touchesWindow = args.event_from !== undefined || args.event_to !== undefined;

    if (args.content === undefined && args.title === undefined && !touchesWindow) {
      throw new Error("nothing to update — provide `content`, `title` and/or an event window.");
    }

    if (
      args.event_from !== undefined &&
      args.event_to !== undefined &&
      args.event_to < args.event_from
    ) {
      throw new Error(
        "`event_to` precedes `event_from`; a fact cannot stop being true before it started.",
      );
    }

    if (args.content !== undefined && args.content.length > MAX_CONTENT) {
      throw new Error(
        `content is ${args.content.length} chars; the limit is ${MAX_CONTENT}. Split this into smaller linked notes.`,
      );
    }

    if (touchesWindow) {
      this.nodes.setEventWindow(args.id, window);
    }

    // The event window is node metadata, not content, so correcting it alone does not mint
    // a revision — there is no new body to keep.
    const envelope =
      args.content === undefined && args.title === undefined
        ? this.nodes.envelope(args.id)!
        : this.nodes.addRevision(args.id, {
            content: args.content,
            title: args.title,
            session_id: args.session_id,
            reason: args.reason ?? null,
            ts: this.clock.now(),
          });

    return hints.length ? { ...envelope, hints } : envelope;
  }
}
