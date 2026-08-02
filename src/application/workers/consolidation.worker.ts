import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  ConsolidationRecommendation,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
} from "@/domain/ports/consolidation-provider";
import { SessionService } from "@/application/services/session.service";
import { annotationFtsText } from "@/consolidation/provider";
import { ConsolidationRepo, EdgesRepo, EmbeddingQueueRepo, NodesRepo } from "@/db/repositories";
import { newId } from "@/core/ids";
import { ConsolidationKind, ConsolidationStatus, EdgeType, Posture } from "@/core/vocab";
import {
  ConsolidationBatchConfig,
  ConsolidationPostureConfig,
  ConsolidationThresholdsConfig,
} from "@/infrastructure/config";

const CONSOLIDATION_LEASE = "consolidation";

export interface ConsolidationTickResult {
  links_added: number;
  links_suggested: number;
  distilled: number;
  distill_suggested: number;
  merged: number;
  merge_suggested: number;
  pruned: number;
  prune_suggested: number;
  proposals_backfilled: number;
  rejected: number;
  annotated: number;
}

// The background consolidation sweep. Runs in the daemon (the one sanctioned writer)
// under its own worker_lease role, so exactly one process consolidates — never
// competing with the embedding drain (the daemon ticks this only when the embedding
// backlog is empty). Detection is deterministic SQL; generation goes through the
// pluggable ConsolidationProvider.
@injectable()
export class ConsolidationWorker {
  private readonly ownerId = newId();
  private readonly leaseTtlMs: number;

  constructor(
    @inject(CONSOLIDATION_PROVIDER_TOKEN)
    private readonly consolidator: ConsolidationProvider,

    private readonly queueRepo: EmbeddingQueueRepo,
    private readonly consolidationRepo: ConsolidationRepo,
    private readonly edgesRepo: EdgesRepo,
    private readonly nodesRepo: NodesRepo,

    private readonly sessionService: SessionService,

    @inject(CLOCK_TOKEN) private readonly clock: Clock,

    private readonly posture: ConsolidationPostureConfig,
    private readonly thresholds: ConsolidationThresholdsConfig,
    private readonly batch: ConsolidationBatchConfig,
  ) {
    // TODO: Config service
    this.leaseTtlMs = 60_000;
  }

  private now() {
    return this.clock.now();
  }

  async stop(): Promise<void> {
    await this.queueRepo.releaseWorkerLease(CONSOLIDATION_LEASE, this.ownerId);
  }

  // One consolidation pass. Side-effecting; tests call it directly with a fixed clock.
  // Only the leaseholder does work — a non-holder returns zeros.
  async tick(): Promise<ConsolidationTickResult> {
    const now = this.now();
    const result: ConsolidationTickResult = {
      links_added: 0,
      links_suggested: 0,
      distilled: 0,
      distill_suggested: 0,
      merged: 0,
      merge_suggested: 0,
      pruned: 0,
      prune_suggested: 0,
      proposals_backfilled: 0,
      rejected: 0,
      annotated: 0,
    };

    const isWorkerReleased = await this.queueRepo.holdWorkerLease(
      CONSOLIDATION_LEASE,
      this.ownerId,
      this.leaseTtlMs,
      this.now(),
    );

    if (!isWorkerReleased) {
      return result;
    }

    this.sessionService.ensureSession(this.ownerId, null, now);

    this.discoverLinks(now, result);
    await this.distill(now, result);
    await this.mergeDuplicates(now, result);
    this.pruneMirrors(now, result);
    await this.backfillProposals(now, result);
    await this.annotate(now, result);

    return result;
  }

  // Generate a judged proposal for a cluster; null if no provider or generation fails
  // (caller degrades to a proposal-less suggestion, never blocks).
  private async tryGenerate(task: ConsolidationTask): Promise<ConsolidationResult | null> {
    if (!this.consolidator.enabled) {
      return null;
    }

    try {
      return await this.consolidator.generate(task);
    } catch {
      return null;
    }
  }

  // similar_to link discovery. Deterministic kNN over stored vectors; no
  // generation. auto -> write system similar_to edges; suggest -> queue; off -> skip.
  private discoverLinks(now: string, result: ConsolidationTickResult): void {
    const posture = this.posture.links;

    if (posture === Posture.OFF) {
      return;
    }

    const pairs = this.consolidationRepo.similarLinkCandidates({
      minScore: this.thresholds.sim,
      limit: this.batch.link,
    });

    for (const p of pairs) {
      if (posture === Posture.AUTO) {
        this.edgesRepo.insertEdge(
          p.src,
          p.dst,
          EdgeType.SIMILAR_TO,
          "system",
          this.ownerId,
          now,
          p.score,
        );
        result.links_added++;
      } else {
        const id = this.consolidationRepo.insertCandidate({
          kind: ConsolidationKind.LINK,
          member_ids: [p.src, p.dst],
          canonical_id: p.dst,
          score: p.score,
          detected_at: now,
        });

        if (id) {
          result.links_suggested++;
        }
      }
    }
  }

  // Episodic -> semantic distillation. Cluster decayed episodics; auto (with a
  // generating provider) writes the durable fact directly; suggest queues a candidate,
  // pre-generating a proposal when a provider is available. A generation failure degrades
  // to a proposal-less suggestion — a weak model can never corrupt memory.
  private async distill(now: string, result: ConsolidationTickResult): Promise<void> {
    const posture = this.posture.distill;

    if (posture === Posture.OFF) {
      return;
    }

    const cutoff = new Date(
      Date.parse(now) - this.thresholds.minAgeDays * 86_400_000,
    ).toISOString();
    const clusters = this.consolidationRepo.staleEpisodicClusters({
      minScore: this.thresholds.sim,
      minCluster: this.thresholds.minCluster,
      cutoff,
      limit: this.batch.distill,
    });

    for (const cluster of clusters) {
      if (this.consolidationRepo.candidateExists(ConsolidationKind.DISTILL, cluster.member_ids)) {
        continue;
      }

      const gen = await this.tryGenerate({
        kind: ConsolidationKind.DISTILL,
        project: cluster.project,
        inputs: this.consolidationRepo.candidateInputs(cluster.member_ids),
      });

      // Provider judged these not worth consolidating -> record a dismissed candidate
      // (with the reason) so it is auditable and never re-proposed.
      if (gen?.recommendation === ConsolidationRecommendation.REJECT) {
        const id = this.consolidationRepo.insertCandidate({
          kind: ConsolidationKind.DISTILL,
          project: cluster.project,
          member_ids: cluster.member_ids,
          score: cluster.score,
          proposal: gen,
          detected_at: now,
        });

        if (id) {
          this.consolidationRepo.resolveCandidate(
            id,
            ConsolidationStatus.DISMISSED,
            this.ownerId,
            now,
          );
          result.rejected++;
        }

        continue;
      }

      if (posture === Posture.AUTO && gen) {
        this.nodesRepo.applyDistillation({
          title: gen.title,
          content: gen.body,
          project: cluster.project,
          sourceIds: cluster.member_ids,
          session_id: this.ownerId,
          ts: now,
        });

        result.distilled++;

        continue;
      }

      const id = this.consolidationRepo.insertCandidate({
        kind: ConsolidationKind.DISTILL,
        project: cluster.project,
        member_ids: cluster.member_ids,
        score: cluster.score,
        proposal: gen,
        detected_at: now,
      });

      if (id) {
        result.distill_suggested++;
      }
    }
  }

  // Semantic dedup/merge. auto merges only with a generating provider (to author
  // the merged body safely); under manual, or on generation failure, it degrades to a
  // suggestion. Never auto-merges authored knowledge without a mind or a model.
  private async mergeDuplicates(now: string, result: ConsolidationTickResult): Promise<void> {
    const posture = this.posture.merge;

    if (posture === Posture.OFF) {
      return;
    }

    const pairs = this.consolidationRepo.duplicateSemanticPairs({
      minScore: this.thresholds.mergeSim,
      limit: this.batch.merge,
    });

    for (const pair of pairs) {
      if (this.consolidationRepo.candidateExists(ConsolidationKind.MERGE, pair.member_ids)) {
        continue;
      }

      const loser = pair.member_ids.find((id) => id !== pair.canonical_id);

      if (!loser) {
        continue;
      }

      const gen = await this.tryGenerate({
        kind: ConsolidationKind.MERGE,
        project: pair.project,
        inputs: this.consolidationRepo.candidateInputs(pair.member_ids),
      });

      // Provider judged these distinct (not a true duplicate) -> dismiss with the reason.
      if (gen?.recommendation === ConsolidationRecommendation.REJECT) {
        const id = this.consolidationRepo.insertCandidate({
          kind: ConsolidationKind.MERGE,
          project: pair.project,
          member_ids: pair.member_ids,
          canonical_id: pair.canonical_id,
          score: pair.score,
          proposal: gen,
          detected_at: now,
        });

        if (id) {
          this.consolidationRepo.resolveCandidate(
            id,
            ConsolidationStatus.DISMISSED,
            this.ownerId,
            now,
          );
          result.rejected++;
        }

        continue;
      }

      if (posture === Posture.AUTO && gen) {
        this.nodesRepo.applyMerge({
          survivorId: pair.canonical_id,
          loserId: loser,
          session_id: this.ownerId,
          ts: now,
          merged: { title: gen.title, body: gen.body },
        });

        result.merged++;

        continue;
      }

      const id = this.consolidationRepo.insertCandidate({
        kind: ConsolidationKind.MERGE,
        project: pair.project,
        member_ids: pair.member_ids,
        canonical_id: pair.canonical_id,
        score: pair.score,
        proposal: gen,
        detected_at: now,
      });

      if (id) {
        result.merge_suggested++;
      }
    }
  }

  // Backfill proposals for pending distill/merge candidates that were queued before a
  // generation provider was available (e.g., detected under `manual`, then switched to
  // `http`). Provider-gated; leaves a candidate untouched on generation failure (retried
  // next sweep). Bounded by `backfillBatch` so a tick stays reasonable.
  private async backfillProposals(now: string, result: ConsolidationTickResult): Promise<void> {
    if (!this.consolidator.enabled) {
      return;
    }

    for (const cand of this.consolidationRepo.pendingNeedingProposal(this.batch.backfill)) {
      if (cand.kind !== ConsolidationKind.DISTILL && cand.kind !== ConsolidationKind.MERGE) {
        continue;
      }

      const inputs = this.consolidationRepo.candidateInputs(cand.member_ids);

      if (!inputs.length) {
        continue;
      }

      const gen = await this.tryGenerate({ kind: cand.kind, project: cand.project, inputs });

      if (!gen) {
        continue; // generation failed -> leave for a later sweep
      }

      this.consolidationRepo.setCandidateProposal(cand.id, gen);

      // Store the verdict either way; auto-dismiss the ones judged not worth consolidating,
      // so the Review inbox surfaces only genuine duplicates.
      if (gen.recommendation === ConsolidationRecommendation.REJECT) {
        this.consolidationRepo.resolveCandidate(
          cand.id,
          ConsolidationStatus.DISMISSED,
          this.ownerId,
          now,
        );
        result.rejected++;
      } else {
        result.proposals_backfilled++;
      }
    }
  }

  // Tier-1 mirror prune. Deterministic, no generation. auto soft-invalidates
  // dead mirror nodes (they then never surface in default search or graph expansion);
  // suggest queues for a prune candidate; off skips. Never touches authored memory.
  private pruneMirrors(now: string, result: ConsolidationTickResult): void {
    const posture = this.posture.prune;

    if (posture === Posture.OFF) {
      return;
    }

    for (const id of this.consolidationRepo.deadMirrorNodes(this.batch.prune)) {
      if (posture === Posture.AUTO) {
        this.nodesRepo.invalidateNode(id, { ts: now, session_id: this.ownerId });
        result.pruned++;
      } else {
        const cid = this.consolidationRepo.insertCandidate({
          kind: ConsolidationKind.PRUNE,
          member_ids: [id],
          score: 1,
          detected_at: now,
        });

        if (cid) {
          result.prune_suggested++;
        }
      }
    }
  }

  // Write-time attribute enrichment. Provider-gated: for each unannotated
  // semantic node, generate keywords/tags/context and fold them into its FTS text for
  // wider recall. Non-destructive — the revision body is untouched, only the FTS index
  // gains terms. A generation failure skips that node (retried next sweep) and never
  // blocks the rest. `suggest` has nothing to review, so it behaves as `auto`; `off` skips.
  private async annotate(now: string, result: ConsolidationTickResult): Promise<void> {
    if (!this.consolidator.enabled || this.posture.annotate === Posture.OFF) {
      return;
    }

    for (const node of this.consolidationRepo.unannotatedSemantic(this.batch.annotate)) {
      let a;

      try {
        a = await this.consolidator.annotate({
          title: node.title,
          content: node.content,
          project: node.project,
        });
      } catch {
        continue;
      }

      const ok = this.nodesRepo.applyAnnotation({
        nodeId: node.id,
        rev: node.rev,
        annotationsJson: JSON.stringify(a),
        ftsText: annotationFtsText(a),
        ts: now,
      });

      if (ok) {
        result.annotated++;
      }
    }
  }
}
