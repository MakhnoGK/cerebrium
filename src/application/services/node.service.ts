import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { NodesRepo } from "@/db/repositories";
import { MemoryKind, NODE_TYPES, typeAllowedForKind, type EdgeType } from "@/core/vocab";

const MAX_CONTENT = 50_000;

@injectable()
export class NodeService {
  constructor(
    private readonly nodesRepo: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  public async createNode({
    title,
    memory_kind,
    type,
    links,
    content,
    project,
    session_id,
    event_from,
    event_to,
  }: object & {
    title: string;
    content: string;
    memory_kind: MemoryKind;
    type: string;
    project: string | null;
    session_id: string;
    links: { dst: string; type: EdgeType }[] | undefined;
    event_from?: string;
    event_to?: string;
  }) {
    if (memory_kind === MemoryKind.MIRROR) {
      throw new Error(
        "Mirror memories (e.g. code symbols) are maintained by the indexer, not written by hand. Run `code_index` to " +
          "index code; write 'semantic' for a decision/gotcha ABOUT code and `link` it to the symbol with a 'documents' edge.",
      );
    }

    if (!typeAllowedForKind(memory_kind, type)) {
      throw new Error(
        `Type '${type}' is not valid for ${memory_kind} memories. Allowed: ${NODE_TYPES[memory_kind].join(", ")}.`,
      );
    }

    if (content.length > MAX_CONTENT) {
      throw new Error(
        `Content is ${content.length} chars; the limit is ${MAX_CONTENT}. Split this into smaller linked notes.`,
      );
    }

    for (const link of links ?? []) {
      if (!(await this.nodesRepo.exists(link.dst))) {
        throw new Error(
          `Link destination '${link.dst}' does not exist. Create it first or fix the id.`,
        );
      }
    }

    return this.nodesRepo.createNode({
      memory_kind,
      type,
      title,
      content,
      project,
      session_id,
      event_from,
      event_to,
      ts: this.clock.now(),
      links,
    });
  }
}
