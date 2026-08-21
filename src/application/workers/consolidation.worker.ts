import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  ConsolidationRecommendation,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
} from "@/domain/ports/consolidation-provider";
import {
  CONSOLIDATION_REPORTER_TOKEN,
  type ConsolidationReporter,
  type ConsolidationTickResult,
} from "@/domain/ports/consolidation-reporter";
import { NodeReferenceService } from "@/application/services/node-reference.service";
import { SessionService } from "@/application/services/session.service";
import { annotationFtsText } from "@/consolidation/provider";
import {
  CodeRepo,
  ConsolidationRepo,
  EdgesRepo,
  EmbeddingQueueRepo,
  NodesRepo,
} from "@/db/repositories";
import { pairKey, type DuplicatePair, type SweepSeed } from "@/db/repositories/consolidation";
import type { Writer } from "@/runtime/client-identity";
import { newId } from "@/core/ids";
import {
  ConsolidationKind,
  ConsolidationStatus,
  EdgeType,
  MemoryKind,
  Posture,
} from "@/core/vocab";
import {
  citedSymbolNames,
  repoBelongsToProject,
  resolveTarget,
  slugify,
  wikilinkTargets,
  type SlugIndex,
} from "@/core/wikilinks";
import {
  ConsolidationBatchConfig,
  ConsolidationConfig,
  ConsolidationPostureConfig,
  ConsolidationThresholdsConfig,
} from "@/infrastructure/config";

const CONSOLIDATION_LEASE = "consolidation";

function slugIndexOf(rows: { id: string; title: string }[]): SlugIndex {
  const index: SlugIndex = new Map();

  for (const row of rows) {
    const slug = slugify(row.title);

    index.set(slug, [...(index.get(slug) ?? []), row.id]);
  }

  return index;
}

function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A breath every `perBreath` items. `await` alone is not enough: a stage whose awaits all
// resolve synchronously only drains the microtask queue, and socket reads are macrotasks.
function breather(perBreath: number): () => Promise<void> {
  let until = perBreath;

  return async () => {
    if (--until > 0) {
      return;
    }

    until = perBreath;

    await breathe();
  };
}

// A neighbour hit, carrying the seed it was found from: the seed's kind decides whether
// merge may consider it, and its ordinal decides which stage's batch budget it falls in.
interface NeighbourPair {
  src: string;
  dst: string;
  score: number;
  seed: SweepSeed;
}

const MAX_ERROR_CHARS = 500;

// Bounded, so a provider that answers with a whole HTML error page cannot dominate the
// tick result an operator reads.
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  return (message || "unknown generation error").slice(0, MAX_ERROR_CHARS);
}

// How a generation attempt ended. A failure and "no generating provider" both yield no
// draft, but they are not the same event — one is a broken sweep, the other is the
// configured posture — so a bare `error: null` marks the second. Collapsing the two into
// one `null` return is what hid a 28% timeout rate for weeks.
type GenerationOutcome =
  { generated: true; result: ConsolidationResult } | { generated: false; error: string | null };

// The sweep runs behind no MCP handshake, so it names itself.
const CONSOLIDATION_WRITER: Writer = { client: "cerebrium-consolidation", version: null };

// The background consolidation sweep. Runs in the daemon (the one sanctioned writer)
// under its own worker_lease role, so exactly one process consolidates — never
// competing with the embedding drain (the daemon ticks this only when the embedding
// backlog is empty). Detection is deterministic SQL; generation goes through the
// pluggable ConsolidationProvider.
@injectable()
export class ConsolidationWorker {
  private readonly ownerId = newId();
  private stopping = false;
  private lastOrphanScan: { watermark: string | null; clean: boolean } | null = null;
  private stageMark: { stage: string; at: number } | null = null;
  private lastCitationScan: {
    revisions: number;
    codeIndex: string | null;
    dangling: number;
  } | null = null;

  constructor(
    @inject(CONSOLIDATION_PROVIDER_TOKEN)
    private readonly consolidator: ConsolidationProvider,
    @inject(CONSOLIDATION_REPORTER_TOKEN)
    private readonly reporter: ConsolidationReporter,

    private readonly queueRepo: EmbeddingQueueRepo,
    private readonly consolidationRepo: ConsolidationRepo,
    private readonly edgesRepo: EdgesRepo,
    private readonly codeRepo: CodeRepo,
    private readonly nodesRepo: NodesRepo,

    private readonly sessionService: SessionService,
    private readonly nodeReferences: NodeReferenceService,

    @inject(CLOCK_TOKEN) private readonly clock: Clock,

    private readonly config: ConsolidationConfig,
    private readonly posture: ConsolidationPostureConfig,
    private readonly thresholds: ConsolidationThresholdsConfig,
    private readonly batch: ConsolidationBatchConfig,
  ) {}

  private now() {
    return this.clock.now();
  }

  async stop(): Promise<void> {
    this.stopping = true;

    await this.queueRepo.releaseWorkerLease(CONSOLIDATION_LEASE, this.ownerId);
  }

  // One consolidation pass. Side-effecting; tests call it directly with a fixed clock.
  // Only the leaseholder does work — a non-holder returns zeros. The lease is re-checked
  // between clusters, so losing it (or being stopped) ends the sweep where it stands and
  // returns what was already done.
  private async report(runId: string, stage: string, result: ConsolidationTickResult) {
    const at = Date.now();

    if (this.stageMark) {
      result.stage_ms = { ...result.stage_ms, [this.stageMark.stage]: at - this.stageMark.at };
    }

    this.stageMark = { stage, at };
    result.stage = stage;
    this.reporter.reportTick(runId, result);
  }

  // `shouldYield` is checked between stages, which is where the sweep already pauses to
  // report progress. Consolidation is background work sharing a process with the reads, so
  // when a client starts waiting it stops after the current stage and resumes next tick
  // rather than holding the CPU for the rest of a sweep.
  async tick(opts: { shouldYield?: () => boolean } = {}): Promise<ConsolidationTickResult> {
    const now = this.now();
    const runId = newId();
    const result: ConsolidationTickResult = {
      started_at: now,
      links_added: 0,
      links_suggested: 0,
      links_pruned: 0,
      wikilinks_linked: 0,
      wikilinks_dangling: 0,
      documents_suggested: 0,
      distilled: 0,
      distill_suggested: 0,
      merged: 0,
      merge_suggested: 0,
      merge_delayed: 0,
      pruned: 0,
      prune_suggested: 0,
      proposals_backfilled: 0,
      rejected: 0,
      annotated: 0,
      generation_failures: 0,
      last_error: null,
    };

    if (!(await this.holdLease())) {
      return result;
    }

    this.sessionService.startSession(this.ownerId, null, now, CONSOLIDATION_WRITER);

    this.stageMark = null;

    try {
      // One kNN pass over the seed set, shared by link discovery and merge detection: the
      // two used to scan the same vectors, differing only in the threshold they applied.
      await this.report(runId, "neighbours", result);

      const neighbours = await this.neighbourPairs();

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "links", result);
      await this.discoverLinks(now, result, neighbours);
      await this.pruneLinks(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "citations", result);
      await this.resolveCitations(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "distill", result);
      await this.distill(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "merge", result);
      await this.mergeDuplicates(now, result, neighbours);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "mirrors", result);
      this.pruneMirrors(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "backfill", result);
      await this.backfillProposals(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "annotate", result);
      await this.annotate(now, result);

      return await this.finish(runId, result);
    } catch (err) {
      result.last_error = errorText(err);
      result.ended_at = this.now();
      await this.report(runId, "failed", result);
    }

    return result;
  }

  private async finish(
    runId: string,
    result: ConsolidationTickResult,
  ): Promise<ConsolidationTickResult> {
    result.ended_at = this.now();
    await this.report(runId, "idle", result);

    return result;
  }

  // Claim or renew the lease, and report whether this worker may keep working. Called
  // once at tick entry and again between clusters: a generation call runs for minutes,
  // so a lease claimed only at entry would read as expired for most of a sweep — to the
  // System tab, to a competing process, and to the one-writer invariant. `stop()` closes
  // the gate first, so a released lease is never re-claimed by a tick already in flight.
  private async holdLease(): Promise<boolean> {
    if (this.stopping) {
      return false;
    }

    return this.queueRepo.holdWorkerLease(
      CONSOLIDATION_LEASE,
      this.ownerId,
      this.config.leaseTtlMs,
      this.now(),
    );
  }

  // One generation attempt, reported in full: the draft, or why there isn't one.
  private async runGeneration(task: ConsolidationTask): Promise<GenerationOutcome> {
    if (!this.consolidator.enabled) {
      return { generated: false, error: null };
    }

    try {
      return { generated: true, result: await this.consolidator.generate(task) };
    } catch (err) {
      return { generated: false, error: errorText(err) };
    }
  }

  // Generate a judged proposal for a cluster; null if no provider or generation fails
  // (caller degrades to a proposal-less suggestion, never blocks). A failure is counted
  // and its reason kept on the tick result, so degrading stays graceful without being mute.
  private async tryGenerate(
    task: ConsolidationTask,
    result: ConsolidationTickResult,
  ): Promise<ConsolidationResult | null> {
    const outcome = await this.runGeneration(task);

    if (outcome.generated) {
      return outcome.result;
    }

    if (outcome.error !== null) {
      result.generation_failures++;
      result.last_error = outcome.error;
    }

    return null;
  }

  // similar_to link discovery. Deterministic kNN over stored vectors; no
  // generation. auto -> write system similar_to edges; suggest -> queue; off -> skip.
  // Neighbour pairs above the *lower* of the two thresholds, so merge can filter the same
  // list at `mergeSim`. A seed budget of max(link, merge) with the seed's ordinal carried
  // through is what keeps each stage's own batch size exact.
  private async neighbourPairs(): Promise<NeighbourPair[]> {
    const budget = Math.max(this.batch.link, this.batch.merge);
    const seen = new Set<string>();
    const out: NeighbourPair[] = [];
    const breath = breather(this.batch.itemsPerBreath);

    for (const seed of this.consolidationRepo.sweepSeeds(budget)) {
      // Each seed is a synchronous vector search, so a whole pass would hold the event
      // loop and the socket with it. The daemon serves reads on this thread.
      await breath();

      for (const nb of this.consolidationRepo.neighboursOf(seed.id, {
        minScore: this.thresholds.sim,
      })) {
        const key = pairKey(seed.id, nb.id);

        if (seen.has(key)) continue;

        seen.add(key);

        const [src, dst] = seed.id < nb.id ? [seed.id, nb.id] : [nb.id, seed.id];

        out.push({ src, dst, score: nb.score, seed });
      }
    }

    return out;
  }

  private async discoverLinks(
    now: string,
    result: ConsolidationTickResult,
    neighbours: NeighbourPair[],
  ): Promise<void> {
    const posture = this.posture.links;

    if (posture === Posture.OFF) {
      return;
    }

    const stored = this.consolidationRepo.storedSimilarPairs();
    const pairs = neighbours
      .filter((n) => n.seed.ordinal < this.batch.link && !stored.has(pairKey(n.src, n.dst)))
      .sort((a, b) => b.score - a.score);

    const maxDegree = this.thresholds.maxLinkDegree;
    const degrees = this.consolidationRepo.linkDegrees([
      ...new Set(pairs.flatMap((p) => [p.src, p.dst])),
    ]);
    const breath = breather(this.batch.itemsPerBreath);

    for (const p of pairs) {
      await breath();

      const srcDegree = degrees.get(p.src) ?? 0;
      const dstDegree = degrees.get(p.dst) ?? 0;

      if (srcDegree >= maxDegree || dstDegree >= maxDegree) {
        continue;
      }

      degrees.set(p.src, srcDegree + 1);
      degrees.set(p.dst, dstDegree + 1);

      if (posture === Posture.AUTO) {
        const inserted = this.edgesRepo.insertSystemSimilarityIfLive(
          p.src,
          p.dst,
          this.ownerId,
          now,
          p.score,
        );
        if (inserted) {
          result.links_added++;
        }
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

  // What a node's prose already claims, made into edges. No posture gate: a wikilink is an
  // authored statement about a relationship, not an inference about one, so there is
  // nothing to suggest and nothing to judge.
  // One pass over authored prose, producing both kinds of citation it can carry: a
  // `[[wikilink]]` to another note, and a `backticked` symbol name from this project's own
  // code. Both need every live body, so they share the read and the watermark.
  private async resolveCitations(now: string, result: ConsolidationTickResult): Promise<void> {
    const revisions = this.consolidationRepo.revisionCount();
    const codeIndex = this.consolidationRepo.codeIndexWatermark();

    if (
      this.lastCitationScan?.revisions === revisions &&
      this.lastCitationScan.codeIndex === codeIndex
    ) {
      result.wikilinks_dangling = this.lastCitationScan.dangling;

      return;
    }

    const bodies = this.consolidationRepo.authoredBodies();
    const live = slugIndexOf(bodies);
    const retired = slugIndexOf(this.consolidationRepo.retiredAuthoredTitles());
    const symbols = this.citableSymbolIndex();
    const breath = breather(this.batch.itemsPerBreath);

    for (const row of bodies) {
      await breath();

      for (const target of wikilinkTargets(row.content)) {
        const dst = this.wikilinkTarget(live, retired, target);

        if (dst === null) {
          result.wikilinks_dangling++;
          continue;
        }

        if (dst === row.id) continue;

        if (this.edgesRepo.insertSystemReferenceIfUnconnected(row.id, dst, this.ownerId, now)) {
          result.wikilinks_linked++;
        }
      }

      this.proposeDocuments(now, result, symbols, row);
    }

    this.lastCitationScan = { revisions, codeIndex, dangling: result.wikilinks_dangling };
  }

  // Cited symbols, by name, excluding repos whose root is gone: a detached repo cannot be
  // checked against source, so nothing new should be linked into it.
  private citableSymbolIndex(): Map<string, { node_id: string; repo: string }[]> {
    const attached = new Set(
      this.codeRepo
        .allRepoProvenance()
        .filter((provenance) => !provenance.detached)
        .map((provenance) => provenance.repo),
    );
    const index = new Map<string, { node_id: string; repo: string }[]>();

    for (const symbol of this.consolidationRepo.citableSymbols()) {
      if (!attached.has(symbol.repo)) continue;

      index.set(symbol.name, [...(index.get(symbol.name) ?? []), symbol]);
    }

    return index;
  }

  // Proposed, never applied: the citation is authored but which symbol it means is
  // inferred, and a wrong edge would be in the graph for good.
  private proposeDocuments(
    now: string,
    result: ConsolidationTickResult,
    symbols: Map<string, { node_id: string; repo: string }[]>,
    row: { id: string; project: string | null; content: string },
  ): void {
    for (const name of citedSymbolNames(row.content)) {
      if (result.documents_suggested >= this.batch.documents) return;

      const targets = new Set(
        (symbols.get(name) ?? [])
          .filter((symbol) => repoBelongsToProject(symbol.repo, row.project))
          .map((symbol) => symbol.node_id),
      );

      if (targets.size !== 1) continue;

      const symbol = [...targets][0]!;

      if (this.edgesRepo.pairIsConnected(row.id, symbol)) continue;

      const id = this.consolidationRepo.insertCandidate({
        kind: ConsolidationKind.DOCUMENTS,
        member_ids: [row.id, symbol],
        canonical_id: symbol,
        score: 1,
        detected_at: now,
      });

      if (id) result.documents_suggested++;
    }
  }

  // A wikilink written before a supersede still names the retired title, so a target that
  // no longer resolves live is followed forward — the same move `invalidate` makes when it
  // repoints a retired node's referrers. More than one successor is not a guess to make.
  private wikilinkTarget(live: SlugIndex, retired: SlugIndex, target: string): string | null {
    const hit = resolveTarget(live, target);

    if (hit.kind === "exact" || hit.kind === "prefix") return hit.id;
    if (hit.kind === "ambiguous") return null;

    const gone = resolveTarget(retired, target);

    if (gone.kind !== "exact" && gone.kind !== "prefix") return null;

    const successors = this.nodeReferences.terminalLiveSuccessors(gone.id);

    return successors.length === 1 ? successors[0]! : null;
  }

  // Retire similar_to edges the cap has already been exceeded by — the backlog the
  // discovery guard cannot reach, since it only governs new pairs. Soft-invalidate only,
  // and never below a node's own top `maxLinkDegree`.
  private async pruneLinks(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.linkPrune === Posture.OFF) {
      return;
    }

    const stale = this.consolidationRepo.overCapSimilarLinks({
      maxDegree: this.thresholds.maxLinkDegree,
      limit: this.batch.linkPrune,
    });
    const breath = breather(this.batch.itemsPerBreath);

    for (const edge of stale) {
      await breath();

      this.edgesRepo.invalidateEdge(edge.src, edge.dst, EdgeType.SIMILAR_TO, now);
      result.links_pruned++;
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
    const breath = breather(this.batch.itemsPerBreath);

    for (const cluster of clusters) {
      await breath();

      if (this.consolidationRepo.candidateExists(ConsolidationKind.DISTILL, cluster.member_ids)) {
        continue;
      }

      if (!(await this.holdLease())) {
        return;
      }

      const gen = await this.tryGenerate(
        {
          kind: ConsolidationKind.DISTILL,
          project: cluster.project,
          inputs: this.consolidationRepo.candidateInputs(cluster.member_ids),
        },
        result,
      );

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
  private inBurst(pair: DuplicatePair, now: string): boolean {
    const window = this.thresholds.mergeBurstMs;

    if (!window || !pair.same_session) {
      return false;
    }

    return Date.parse(now) - Date.parse(pair.youngest_created_at) < window;
  }

  private async mergeDuplicates(
    now: string,
    result: ConsolidationTickResult,
    neighbours: NeighbourPair[],
  ): Promise<void> {
    const posture = this.posture.merge;

    if (posture === Posture.OFF) {
      return;
    }

    // Semantic seeds only: a merge folds one authored node into another, and an episodic
    // is write-once. Only the seed side of a pair can be episodic.
    const hits = neighbours.filter(
      (n) =>
        n.seed.kind === MemoryKind.SEMANTIC &&
        n.seed.ordinal < this.batch.merge &&
        n.score >= this.thresholds.mergeSim,
    );

    const breath = breather(this.batch.itemsPerBreath);

    for (const hit of hits) {
      await breath();

      const pair = this.consolidationRepo.duplicatePairFor(hit.src, hit.dst, hit.score);

      if (pair === null) {
        continue;
      }

      if (!(await this.holdLease())) {
        return;
      }

      // A pair one session wrote minutes apart is a series, not a duplication: the writer
      // held both in context and still wrote two. Let it age instead of proposing it —
      // the pair stays detectable and returns on a later sweep.
      if (this.inBurst(pair, now)) {
        result.merge_delayed++;
        continue;
      }

      const loser = pair.member_ids.find((id) => id !== pair.canonical_id);

      if (!loser) {
        continue;
      }

      const gen = await this.tryGenerate(
        {
          kind: ConsolidationKind.MERGE,
          project: pair.project,
          inputs: this.consolidationRepo.candidateInputs(pair.member_ids),
        },
        result,
      );

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

      // AUTO no longer rewrites and invalidates: it records the relationship and leaves
      // both nodes live, so an 88.3%-precision judge costs a ranking nudge, not a node.
      // Collapsing two nodes into one is `consolidate_apply` with `collapse`, by hand.
      if (posture === Posture.AUTO) {
        const recorded = this.edgesRepo.insertDuplicateOfIfLive(
          loser,
          pair.canonical_id,
          this.ownerId,
          now,
          pair.score,
        );

        if (recorded) {
          result.merged++;
        }

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
      if (!(await this.holdLease())) {
        return;
      }

      if (cand.kind !== ConsolidationKind.DISTILL && cand.kind !== ConsolidationKind.MERGE) {
        continue;
      }

      const inputs = this.consolidationRepo.candidateInputs(cand.member_ids);

      if (!inputs.length) {
        continue;
      }

      const gen = await this.tryGenerate(
        { kind: cand.kind, project: cand.project, inputs },
        result,
      );

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

    const watermark = this.consolidationRepo.codeIndexWatermark();

    if (this.lastOrphanScan?.clean === true && this.lastOrphanScan.watermark === watermark) {
      return;
    }

    const dead = this.consolidationRepo.deadMirrorNodes(this.batch.prune);

    // Not clean means the batch limit may have truncated the list, so the next sweep looks
    // again whatever the watermark says.
    this.lastOrphanScan = { watermark, clean: dead.length === 0 };

    for (const id of dead) {
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
      if (!(await this.holdLease())) {
        return;
      }

      let a;

      try {
        a = await this.consolidator.annotate({
          title: node.title,
          content: node.content,
          project: node.project,
        });
      } catch (err) {
        result.generation_failures++;
        result.last_error = errorText(err);

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

// A yielded sweep is not a failure: the stages it completed stand, and the rest happens on
// the next tick. Recorded on the result so an operator can see it happened rather than
// wondering why a sweep did less than usual.
function yielded(opts: { shouldYield?: () => boolean }, result: ConsolidationTickResult): boolean {
  if (opts.shouldYield?.() !== true) return false;

  result.yielded = true;

  return true;
}
