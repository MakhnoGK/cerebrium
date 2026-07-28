import { inject, injectable } from "tsyringe";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  ReconcileAction,
  type ConsolidationProvider,
} from "@/domain/ports/consolidation-provider";
import { NodesRepo } from "@/db/repositories";

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

@injectable()
export class ConsolidationService {
  constructor(
    private readonly nodesRepo: NodesRepo,
    @inject(CONSOLIDATION_PROVIDER_TOKEN) private readonly consolidator: ConsolidationProvider,
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

      const isNoop = consolidationResult.action === ReconcileAction.NOOP;
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
