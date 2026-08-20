import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { EmbeddingService, NodeReferenceService } from "@/application/services";
import {
  LINK_NODES,
  useCase,
  type LinkNodes,
  type LinkNodesArgs,
  type LinkNodesResult,
} from "@/application/use-cases/contracts";
import { EdgesRepo } from "@/db/repositories";
import { SYSTEM_EDGE_TYPES } from "@/core/vocab";

@useCase(LINK_NODES)
export class LocalLinkNodes implements LinkNodes {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly references: NodeReferenceService,
    private readonly edges: EdgesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  invoke(args: LinkNodesArgs): Promise<LinkNodesResult> {
    if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(args.type)) {
      throw new Error(
        `'${args.type}' edges are created by the system, not via link. Use another edge type.`,
      );
    }

    if (args.src === args.dst) throw new Error("cannot link a node to itself.");
    this.references.requireLive(args.src, "src node");
    this.references.requireLive(args.dst, "dst node");

    const weight = args.weight ?? 1.0;

    this.edges.insertEdge(
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
      notes: this.embeddings.getEmbeddingNotes(),
    });
  }
}
