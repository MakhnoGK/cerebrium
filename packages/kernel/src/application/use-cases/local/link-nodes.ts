import { inject } from "tsyringe";
import { SYSTEM_EDGE_TYPES } from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { EDGES_REPO_TOKEN, type EdgesRepo } from "@/domain/ports/storage";
import { EmbeddingService, NodeReferenceService } from "@/application/services";
import {
  LINK_NODES,
  useCase,
  type LinkNodes,
  type LinkNodesArgs,
  type LinkNodesResult,
} from "@/application/use-cases/contracts";

@useCase(LINK_NODES)
export class LocalLinkNodes implements LinkNodes {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly references: NodeReferenceService,
    @inject(EDGES_REPO_TOKEN) private readonly edges: EdgesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async invoke(args: LinkNodesArgs): Promise<LinkNodesResult> {
    if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(args.type)) {
      throw new Error(
        `'${args.type}' edges are created by the system, not via link. Use another edge type.`,
      );
    }

    if (args.src === args.dst) throw new Error("cannot link a node to itself.");
    await this.references.requireLive(args.src, "src node");
    await this.references.requireLive(args.dst, "dst node");

    const weight = args.weight ?? 1.0;

    await this.edges.insertEdge(
      args.src,
      args.dst,
      args.type,
      "agent",
      args.session_id,
      this.clock.now(),
      weight,
    );

    return Promise.resolve({
      src: args.src,
      dst: args.dst,
      type: args.type,
      weight,
      notes: await this.embeddings.getEmbeddingNotes(),
    });
  }
}
