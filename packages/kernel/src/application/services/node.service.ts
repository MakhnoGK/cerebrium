import { inject, injectable } from "tsyringe";
import type { CodeContext } from "@cerebrium/contracts/code";
import { EdgeType, MemoryKind, NODE_TYPES, typeAllowedForKind } from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { CodeRefService, type CodeRefTarget } from "@/application/services/code-ref.service";
import { NodeReferenceService } from "@/application/services/node-reference.service";

const MAX_CONTENT = 50_000;

@injectable()
export class NodeService {
  constructor(
    @inject(NODES_REPO_TOKEN) private readonly nodesRepo: NodesRepo,
    private readonly references: NodeReferenceService,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
    private readonly codeRefs: CodeRefService,
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
    parent_node_id,
    code_context,
  }: object & {
    title: string;
    content: string;
    memory_kind: MemoryKind;
    type: string;
    project: string | null;
    session_id: string;
    links: { dst: string; type: EdgeType }[] | undefined;
    parent_node_id: string | null;
    event_from?: string;
    event_to?: string;
    code_context?: CodeContext;
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

    const resolvedLinks = [...(links ?? [])];

    if (parent_node_id !== null) {
      await this.references.requireLive(parent_node_id, "parent node");

      if (
        !resolvedLinks.some(
          (link) => link.dst === parent_node_id && link.type === EdgeType.RELATES_TO,
        )
      ) {
        resolvedLinks.push({ dst: parent_node_id, type: EdgeType.RELATES_TO });
      }
    }

    const nodeLinks: typeof resolvedLinks = [];
    const codeLinks: { type: EdgeType; target: CodeRefTarget }[] = [];

    for (const link of resolvedLinks) {
      const target = await this.codeRefs.target(link.dst, code_context);

      if (target) {
        codeLinks.push({ type: link.type, target });

        continue;
      }

      await this.references.requireLive(link.dst, "link destination");
      nodeLinks.push(link);
    }

    const ts = this.clock.now();
    const envelope = await this.nodesRepo.createNode({
      memory_kind,
      type,
      title,
      content,
      project,
      session_id,
      event_from,
      event_to,
      ts,
      links: nodeLinks,
    });

    for (const link of codeLinks) {
      await this.codeRefs.record(envelope.id, link.type, link.target, ts);
    }

    return envelope;
  }
}
