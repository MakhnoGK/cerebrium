import { inject } from "tsyringe";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { HintsService } from "@/application/services";
import {
  UPDATE_MEMORY,
  useCase,
  type UpdateMemory,
  type UpdateMemoryArgs,
  type UpdateMemoryResult,
} from "@/application/use-cases/contracts";

const MAX_CONTENT = 50_000;

@useCase(UPDATE_MEMORY)
export class LocalUpdateMemory implements UpdateMemory {
  constructor(
    private readonly hints: HintsService,
    @inject(NODES_REPO_TOKEN) private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: UpdateMemoryArgs): Promise<UpdateMemoryResult> {
    const current = await this.nodes.envelope(args.id);

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
      await this.nodes.setEventWindow(args.id, window);
    }

    // The event window is node metadata, not content, so correcting it alone does not mint
    // a revision — there is no new body to keep.
    const envelope =
      args.content === undefined && args.title === undefined
        ? (await this.nodes.envelope(args.id))!
        : await this.nodes.addRevision(args.id, {
            content: args.content,
            title: args.title,
            session_id: args.session_id,
            reason: args.reason ?? null,
            ts: this.clock.now(),
          });

    return Promise.resolve({
      envelope,
      notes: args.content === undefined ? [] : this.hints.getLongBodyNotes(args.content),
    });
  }
}
