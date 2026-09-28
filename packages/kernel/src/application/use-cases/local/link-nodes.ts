import { inject } from "tsyringe";
import { SYSTEM_EDGE_TYPES } from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { EDGES_REPO_TOKEN, type EdgesRepo } from "@/domain/ports/storage";
import { CodeRefService, EmbeddingService, NodeReferenceService } from "@/application/services";
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
    private readonly codeRefs: CodeRefService,
  ) {}

  async invoke(args: LinkNodesArgs): Promise<LinkNodesResult> {
    if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(args.type)) {
      throw new Error(
        `'${args.type}' edges are created by the system, not via link. Use another edge type.`,
      );
    }

    if (args.src === args.dst) throw new Error("cannot link a node to itself.");

    if (await this.codeRefs.target(args.src, args.code_context)) {
      throw new Error("a code symbol can only be a link's dst: link from the note to the code.");
    }

    await this.references.requireLive(args.src, "src node");

    const weight = args.weight ?? 1.0;
    const code = await this.codeRefs.target(args.dst, args.code_context);

    if (code) {
      await this.codeRefs.record(args.src, args.type, code, this.clock.now());

      return {
        src: args.src,
        dst: args.dst,
        type: args.type,
        weight,
        notes: [
          `linked to ${code.qualified} in ${code.repo} by path and name, so the link follows ` +
            "the symbol onto every branch that has it.",
        ],
      };
    }

    await this.references.requireLive(args.dst, "dst node");

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
