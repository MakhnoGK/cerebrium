import { ConsolidationProvider, createConsolidator } from "@/consolidation";
import { NodesRepo } from "@/db/repositories";
import { container, inject, injectable } from "tsyringe";

const RECONCILE_CANDIDATES = 3;

interface SimilarExisting {
  id: string;
  title: string;
  summary: string;
  score: number;
  suggestion: string;
}

interface ReconcileCandidate {
  id: string;
  title: string;
  content: string;
}

interface ReconcileVO {
  project: string | null;
  similar: SimilarExisting[];
  draft: { title: string; type: string; content: string };
}

export const CONSOLIDATOR_TOKEN = Symbol("consolidator-token");

container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });

@injectable()
export class ConsolidationService {
  constructor(
    private readonly nodesRepo: NodesRepo,
    @inject(CONSOLIDATOR_TOKEN) private readonly consolidator: ConsolidationProvider,
  ) {}

  // Ask the provider to judge the new draft against its nearest existing records: keep,
  // update one, or supersede one. Reads full content for the top few candidates (they
  // already cleared the dedup threshold). Advisory: any failure returns null, so the writing
  // is unaffected, and a non-noop verdict must name a real candidate, or it decays to noop.
  public async reconcile({ project, similar, draft }: ReconcileVO) {
    try {
      const candidates = await this.getReconcileCandidates(similar);

      if (!candidates.length) {
        return null;
      }

      const consolidationResult = await this.consolidator.reconcile({
        draft,
        project,
        candidates,
      });

      const isNoop = consolidationResult.action === "noop";
      const hasTargetCandidates = candidates.some((c) => c.id === consolidationResult.target_id);

      if (!isNoop && !hasTargetCandidates) {
        return { action: "noop", target_id: null, reason: consolidationResult.reason };
      }

      return consolidationResult;
    } catch {
      return null;
    }
  }

  private async getReconcileCandidates(similarNodes: SimilarExisting[]) {
    return (
      await Promise.all(
        similarNodes.slice(0, RECONCILE_CANDIDATES).map(async (similarNode) => {
          const fullNode = await this.nodesRepo.fullNode(similarNode.id);

          if (fullNode) {
            return {
              id: similarNode.id,
              title: fullNode.envelope.title,
              content: fullNode.content,
            };
          }

          return null;
        }),
      )
    ).filter((candidate): candidate is ReconcileCandidate => candidate !== null);
  }
}
