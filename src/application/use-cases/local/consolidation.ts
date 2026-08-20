import { inject } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import {
  APPLY_CANDIDATE,
  RETRY_CANDIDATE,
  SUGGEST_CANDIDATES,
  useCase,
  type ApplyCandidate,
  type ApplyCandidateArgs,
  type ApplyCandidateResult,
  type RetryCandidate,
  type RetryCandidateArgs,
  type RetryCandidateResult,
  type SuggestCandidates,
  type SuggestCandidatesArgs,
  type SuggestCandidatesResult,
} from "@/application/use-cases/contracts";
import { ConsolidationRepo, EdgesRepo, NodesRepo } from "@/db/repositories";
import { ConsolidationKind, ConsolidationStatus } from "@/core/vocab";

@useCase(SUGGEST_CANDIDATES)
export class LocalSuggestCandidates implements SuggestCandidates {
  constructor(private readonly consolidation: ConsolidationRepo) {}

  invoke(args: SuggestCandidatesArgs): Promise<SuggestCandidatesResult> {
    return Promise.resolve({
      candidates: this.consolidation.pendingCandidates({ kind: args.kind, limit: args.limit }),
    });
  }
}

@useCase(APPLY_CANDIDATE)
export class LocalApplyCandidate implements ApplyCandidate {
  constructor(
    private readonly consolidation: ConsolidationRepo,
    private readonly edges: EdgesRepo,
    private readonly nodes: NodesRepo,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  invoke(args: ApplyCandidateArgs): Promise<ApplyCandidateResult> {
    const current = this.consolidation.getCandidate(args.id);

    if (!current) throw new Error(`no consolidation candidate ${args.id}.`);
    if (current.status !== ConsolidationStatus.PENDING) {
      throw new Error(`candidate ${args.id} is already ${current.status}.`);
    }

    const now = this.clock.now();
    const resolved = this.consolidation.resolveCandidateAtomically(
      args.id,
      args.session_id,
      now,
      (candidate) => {
        if (args.decision === ConsolidationRecommendation.REJECT) {
          return ConsolidationStatus.DISMISSED;
        }

        if (candidate.kind === ConsolidationKind.LINK) {
          const [src, dst] = candidate.member_ids;
          if (!src || !dst) throw new Error(`link candidate ${args.id} is malformed.`);

          const inserted = this.edges.insertSystemSimilarityIfLive(
            src,
            dst,
            args.session_id,
            now,
            candidate.score,
          );
          return inserted ? ConsolidationStatus.APPLIED : ConsolidationStatus.DISMISSED;
        }

        if (candidate.kind === ConsolidationKind.DISTILL) {
          const result = args.override ?? candidate.proposal;
          if (!result) {
            throw new Error(
              `distill candidate ${args.id} has no proposal — provide override {title,summary,body}.`,
            );
          }

          this.nodes.applyDistillation({
            title: result.title,
            content: result.body,
            project: candidate.project,
            sourceIds: candidate.member_ids,
            session_id: args.session_id,
            ts: now,
          });
          return ConsolidationStatus.APPLIED;
        }

        if (candidate.kind === ConsolidationKind.MERGE) {
          const survivor = candidate.canonical_id;
          const loser = candidate.member_ids.find((mid) => mid !== survivor);
          if (!survivor || !loser) throw new Error(`merge candidate ${args.id} is malformed.`);

          if (!args.collapse) {
            const recorded = this.edges.insertDuplicateOfIfLive(
              loser,
              survivor,
              args.session_id,
              now,
              candidate.score,
            );
            return recorded ? ConsolidationStatus.APPLIED : ConsolidationStatus.DISMISSED;
          }

          const merged = args.override ?? candidate.proposal;
          const applied = this.nodes.applyMerge({
            survivorId: survivor,
            loserId: loser,
            session_id: args.session_id,
            ts: now,
            merged: merged ? { title: merged.title, body: merged.body } : undefined,
          });
          return applied ? ConsolidationStatus.APPLIED : ConsolidationStatus.DISMISSED;
        }

        const [target] = candidate.member_ids;
        if (!target) throw new Error(`prune candidate ${args.id} is malformed.`);
        this.nodes.invalidateNode(target, { ts: now, session_id: args.session_id });
        return ConsolidationStatus.APPLIED;
      },
    );

    if (!resolved) {
      const latest = this.consolidation.getCandidate(args.id);
      throw new Error(`candidate ${args.id} is already ${latest?.status ?? "resolved"}.`);
    }

    return Promise.resolve({
      id: args.id,
      status: resolved.status,
      kind: resolved.candidate.kind,
    });
  }
}

@useCase(RETRY_CANDIDATE)
export class LocalRetryCandidate implements RetryCandidate {
  constructor(private readonly consolidation: ConsolidationRepo) {}

  invoke({ id }: RetryCandidateArgs): Promise<RetryCandidateResult> {
    this.consolidation.clearCandidateProposal(id, null);
    this.consolidation.reopenCandidate(id);

    return Promise.resolve({ status: "reopened", id });
  }
}
