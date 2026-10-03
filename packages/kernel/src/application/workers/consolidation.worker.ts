import { existsSync } from "node:fs";
import { inject, injectable } from "tsyringe";
import {
  ConsolidationKind,
  ConsolidationStatus,
  EdgeType,
  EventAction,
  MemoryKind,
  Posture,
} from "@cerebrium/contracts/vocab";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  ConsolidationRecommendation,
  LinkConfidence,
  LinkRelation,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
  type LinkCandidate,
  type RelateResult,
  type ResolveLinkResult,
} from "@/domain/ports/consolidation-provider";
import {
  CONSOLIDATION_REPORTER_TOKEN,
  type ConsolidationReporter,
  type ConsolidationTickResult,
} from "@/domain/ports/consolidation-reporter";
import {
  BRANCH_CODE_REPO_TOKEN,
  CODE_REPO_TOKEN,
  CONSOLIDATION_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  EMBEDDING_QUEUE_REPO_TOKEN,
  NODES_REPO_TOKEN,
  pairKey,
  SESSIONS_REPO_TOKEN,
  STORE_TOKEN,
  type BranchCodeRepo,
  type CodeRepo,
  type ConsolidationRepo,
  type DuplicatePair,
  type EdgesRepo,
  type EmbeddingQueueRepo,
  type NodesRepo,
  type RelationInput,
  type SessionsRepo,
  type Store,
  type SweepSeed,
} from "@/domain/ports/storage";
import { ActivityFeed } from "@/application/services/activity-feed.service";
import type { CodeRefTarget } from "@/application/services/code-ref.service";
import { NodeProtectionService } from "@/application/services/node-protection.service";
import { NodeReferenceService } from "@/application/services/node-reference.service";
import { SessionService } from "@/application/services/session.service";
import {
  WikilinkDanglerService,
  type Dangler,
} from "@/application/services/wikilink-dangler.service";
import { WikilinkResolverService } from "@/application/services/wikilink-resolver.service";
import { annotationFtsText } from "@/consolidation/provider";
import type { Writer } from "@/runtime/client-identity";
import { newId } from "@/core/ids";
import {
  citedSymbolNames,
  idTarget,
  repoBelongsToProject,
  wikilinkContext,
  wikilinkTargets,
} from "@/core/wikilinks";
import {
  ConsolidationBatchConfig,
  ConsolidationConfig,
  ConsolidationPostureConfig,
  ConsolidationThresholdsConfig,
} from "@/infrastructure/config";

const CONSOLIDATION_LEASE = "consolidation";

function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// A breath once `budgetMs` of wall-clock has passed since the last one, which is what
// bounds how long a waiting client can be blocked. Measured by time rather than by a count
// of items because per-item cost across these loops spans a seed's ~7ms kNN to a distill
// cluster's hundreds of ms: a fixed cadence either never fires in a short expensive loop or
// fires far too often in a long cheap one.
//
// `await` alone is not enough: a stage whose awaits all resolve synchronously only drains
// the microtask queue, and socket reads are macrotasks.
function breather(budgetMs: number): () => Promise<void> {
  let last = Date.now();

  return async () => {
    if (Date.now() - last < budgetMs) {
      return;
    }

    await breathe();

    last = Date.now();
  };
}

// A symbol a note can cite by name; `ref` is set on the per-branch index, where the
// citation is kept as a code ref rather than an edge.
interface CitableSymbol {
  node_id: string;
  repo: string;
  ref: CodeRefTarget | null;
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
const REATTACH_CANDIDATES = 3;
const LINK_NEIGHBOURS = 3;
const LINK_CANDIDATES = 6;

interface Judgement {
  a: RelationInput;
  b: RelationInput;
  verdict: RelateResult;
}

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
  // The run this worker has open, so a stop can close it. A tick that is killed mid-await
  // never reaches `finish`, and an unclosed row reads as a sweep still in progress forever.
  private currentRun: string | null = null;
  private lastOrphanScan: { watermark: string | null; clean: boolean } | null = null;
  private stageMark: { stage: string; at: number } | null = null;
  private lastCitationScan: {
    revisions: number;
    codeIndex: string | null;
    dangling: number;
    danglingById: number;
  } | null = null;
  private readonly unrelated = new Set<string>();
  private wikilinkBacklog = 0;
  private principal: string | null = null;

  constructor(
    @inject(CONSOLIDATION_PROVIDER_TOKEN)
    private readonly consolidator: ConsolidationProvider,
    @inject(CONSOLIDATION_REPORTER_TOKEN)
    private readonly reporter: ConsolidationReporter,

    @inject(EMBEDDING_QUEUE_REPO_TOKEN) private readonly queueRepo: EmbeddingQueueRepo,
    @inject(CONSOLIDATION_REPO_TOKEN) private readonly consolidationRepo: ConsolidationRepo,
    @inject(EDGES_REPO_TOKEN) private readonly edgesRepo: EdgesRepo,
    @inject(CODE_REPO_TOKEN) private readonly codeRepo: CodeRepo,
    @inject(BRANCH_CODE_REPO_TOKEN) private readonly branchCode: BranchCodeRepo,
    @inject(NODES_REPO_TOKEN) private readonly nodesRepo: NodesRepo,
    @inject(STORE_TOKEN) private readonly store: Store,
    @inject(SESSIONS_REPO_TOKEN) private readonly sessionsRepo: SessionsRepo,

    private readonly sessionService: SessionService,
    private readonly nodeReferences: NodeReferenceService,
    private readonly wikilinks: WikilinkResolverService,
    private readonly danglers: WikilinkDanglerService,
    private readonly protection: NodeProtectionService,
    private readonly feed: ActivityFeed,

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

    const abandoned = this.currentRun;
    this.currentRun = null;

    if (abandoned !== null) {
      await this.reporter.closeRun(abandoned, this.now(), "the daemon stopped mid-sweep");
    }

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
    await this.reporter.reportTick(runId, result);
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
      documents_linked: 0,
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
      integrity: {
        wikilinks_by_id: 0,
        wikilinks_dangling_id: 0,
        reattached: 0,
        links_typed: 0,
        links_dropped: 0,
        links_to_review: 0,
        superseded: 0,
        edges_repointed: 0,
        wikilinks_fixed: 0,
        wikilinks_unlinked: 0,
        wikilinks_to_review: 0,
      },
    };

    if (!(await this.holdLease())) {
      return result;
    }

    this.currentRun = runId;

    this.principal = await this.sessionService.startSession(
      this.ownerId,
      null,
      now,
      CONSOLIDATION_WRITER,
    );

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
      await this.pruneMirrors(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "retired", result);
      await this.consolidationRepo.dismissRetiredCandidates(this.ownerId, now);

      await this.report(runId, "integrity", result);
      await this.repointStranded(now, result);
      await this.unlinkCrossProject(now, result);
      await this.reattach(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "backfill", result);
      await this.backfillProposals(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "retype", result);
      await this.settleSupersedes(now, result);
      await this.retypeLinks(now, result);
      await this.recheckLinks(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "wikilinks", result);
      await this.resolveWikilinks(now, result);

      if (yielded(opts, result)) return await this.finish(runId, result);

      await this.report(runId, "annotate", result);
      await this.annotate(now, result);

      return await this.finish(runId, result);
    } catch (err) {
      result.last_error = errorText(err);
      result.ended_at = this.now();
      await this.report(runId, "failed", result);
      this.currentRun = null;
    }

    return result;
  }

  private async finish(
    runId: string,
    result: ConsolidationTickResult,
  ): Promise<ConsolidationTickResult> {
    result.ended_at = this.now();
    await this.report(runId, "idle", result);
    this.currentRun = null;

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

    return await this.queueRepo.holdWorkerLease(
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

    if (!outcome.generated) {
      if (outcome.error !== null) {
        result.generation_failures++;
        result.last_error = outcome.error;
      }

      return null;
    }

    const first = outcome.result;

    if (
      task.kind !== ConsolidationKind.MERGE ||
      first.recommendation !== ConsolidationRecommendation.APPLY ||
      !first.missing.length
    ) {
      return first;
    }

    if (!(await this.holdLease())) {
      return first;
    }

    const retry = await this.runGeneration({ ...task, missing: first.missing });

    return retry.generated &&
      retry.result.recommendation === ConsolidationRecommendation.APPLY &&
      retry.result.missing.length < first.missing.length
      ? retry.result
      : first;
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
    const breath = breather(this.batch.msPerBreath);

    for (const seed of await this.consolidationRepo.sweepSeeds(budget)) {
      // Each seed is a synchronous vector search, so a whole pass would hold the event
      // loop and the socket with it. The daemon serves reads on this thread.
      await breath();

      for (const nb of await this.consolidationRepo.neighboursOf(seed.id, {
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

    const stored = await this.consolidationRepo.storedSimilarPairs();
    const pairs = neighbours
      .filter((n) => n.seed.ordinal < this.batch.link && !stored.has(pairKey(n.src, n.dst)))
      .sort((a, b) => b.score - a.score);

    const maxDegree = this.thresholds.maxLinkDegree;
    const degrees = await this.consolidationRepo.linkDegrees([
      ...new Set(pairs.flatMap((p) => [p.src, p.dst])),
    ]);
    const breath = breather(this.batch.msPerBreath);

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
        const inserted = await this.edgesRepo.insertSystemSimilarityIfLive(
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
        const id = await this.consolidationRepo.insertCandidate({
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
    const revisions = await this.consolidationRepo.revisionCount();
    const codeIndex = this.store.capabilities.branchCode
      ? await this.branchCode.indexWatermark()
      : await this.consolidationRepo.codeIndexWatermark();

    if (
      this.lastCitationScan?.revisions === revisions &&
      this.lastCitationScan.codeIndex === codeIndex
    ) {
      result.wikilinks_dangling = this.lastCitationScan.dangling;
      result.integrity!.wikilinks_dangling_id = this.lastCitationScan.danglingById;

      return;
    }

    const bodies = await this.consolidationRepo.authoredBodies();
    const links = await this.wikilinks.index(bodies);
    const symbols = await this.citableSymbolIndex();
    const breath = breather(this.batch.msPerBreath);

    for (const row of bodies) {
      await breath();

      for (const target of wikilinkTargets(row.content)) {
        const id = idTarget(target);
        const outcome = await links.resolve(target);
        const dst = "id" in outcome ? outcome.id : null;

        if (dst === null) {
          if (id === null) result.wikilinks_dangling++;
          else result.integrity!.wikilinks_dangling_id++;
          continue;
        }

        if (dst === row.id) continue;

        if (
          await this.edgesRepo.insertSystemReferenceIfUnconnected(row.id, dst, this.ownerId, now)
        ) {
          result.wikilinks_linked++;
          if (id !== null) result.integrity!.wikilinks_by_id++;
        }
      }

      await this.proposeDocuments(now, result, symbols, row);
    }

    this.lastCitationScan = {
      revisions,
      codeIndex,
      dangling: result.wikilinks_dangling,
      danglingById: result.integrity!.wikilinks_dangling_id,
    };
  }

  // Cited symbols, by name. On the per-branch index a citation is kept as a ref to what the
  // symbol is, so each carries that target. On the local mirror, repos whose root is gone are
  // left out: a detached repo cannot be checked against source.
  private async citableSymbolIndex(): Promise<Map<string, CitableSymbol[]>> {
    const index = new Map<string, CitableSymbol[]>();

    if (this.store.capabilities.branchCode) {
      for (const s of await this.branchCode.citableSymbols()) {
        const ref: CodeRefTarget = {
          repo: s.repo,
          remote_key: s.remote_key,
          path: s.path,
          qualified: s.qualified,
          symbol_kind: s.kind,
        };

        index.set(s.name, [...(index.get(s.name) ?? []), { node_id: s.id, repo: s.repo, ref }]);
      }

      return index;
    }

    const attached = new Set(
      (await this.codeRepo.allRepoProvenance())
        .filter((provenance) => !provenance.detached)
        .map((provenance) => provenance.repo),
    );

    for (const symbol of await this.consolidationRepo.citableSymbols()) {
      if (!attached.has(symbol.repo)) continue;

      index.set(symbol.name, [...(index.get(symbol.name) ?? []), { ...symbol, ref: null }]);
    }

    return index;
  }

  private async cited(note: string, symbol: CitableSymbol): Promise<boolean> {
    return symbol.ref
      ? this.branchCode.hasRef(note, symbol.ref.remote_key!, symbol.ref.path, symbol.ref.qualified)
      : this.edgesRepo.pairIsConnected(note, symbol.node_id);
  }

  private async linkDocuments(note: string, symbol: CitableSymbol, now: string): Promise<boolean> {
    if (!symbol.ref) {
      return this.edgesRepo.insertSystemDocumentsIfLive(note, symbol.node_id, this.ownerId, now);
    }

    await this.branchCode.insertRef({ src: note, type: EdgeType.DOCUMENTS, ...symbol.ref }, now);

    return true;
  }

  // Proposed, never applied: the citation is authored but which symbol it means is
  // inferred, and a wrong edge would be in the graph for good.
  private async proposeDocuments(
    now: string,
    result: ConsolidationTickResult,
    symbols: Map<string, CitableSymbol[]>,
    row: { id: string; project: string | null; content: string },
  ): Promise<void> {
    const posture = this.posture.documents;

    if (posture === Posture.OFF) {
      return;
    }

    for (const name of citedSymbolNames(row.content)) {
      if (result.documents_linked + result.documents_suggested >= this.batch.documents) return;

      const targets = new Map(
        (symbols.get(name) ?? [])
          .filter((symbol) => repoBelongsToProject(symbol.repo, row.project))
          .map((symbol) => [symbol.node_id, symbol]),
      );

      if (targets.size !== 1) continue;

      const target = [...targets.values()][0]!;
      const symbol = target.node_id;

      if (await this.cited(row.id, target)) continue;

      if (posture === Posture.AUTO) {
        if (await this.linkDocuments(row.id, target, now)) {
          result.documents_linked++;
          await this.consolidationRepo.resolvePendingByMembers(
            ConsolidationKind.DOCUMENTS,
            [row.id, symbol],
            ConsolidationStatus.APPLIED,
            this.ownerId,
            now,
          );
        }

        continue;
      }

      const id = await this.consolidationRepo.insertCandidate({
        kind: ConsolidationKind.DOCUMENTS,
        member_ids: [row.id, symbol],
        canonical_id: symbol,
        score: 1,
        detected_at: now,
      });

      if (id) result.documents_suggested++;
    }
  }

  // Retire similar_to edges the cap has already been exceeded by — the backlog the
  // discovery guard cannot reach, since it only governs new pairs. Soft-invalidate only,
  // and never below a node's own top `maxLinkDegree`.
  private async pruneLinks(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.linkPrune === Posture.OFF) {
      return;
    }

    const stale = await this.consolidationRepo.overCapSimilarLinks({
      maxDegree: this.thresholds.maxLinkDegree,
      limit: this.batch.linkPrune,
    });
    const breath = breather(this.batch.msPerBreath);

    for (const edge of stale) {
      await breath();

      await this.edgesRepo.invalidateEdge(edge.src, edge.dst, EdgeType.SIMILAR_TO, now);
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
    const clusters = await this.consolidationRepo.staleEpisodicClusters({
      minScore: this.thresholds.sim,
      minCluster: this.thresholds.minCluster,
      cutoff,
      limit: this.batch.distill,
    });
    const breath = breather(this.batch.msPerBreath);

    for (const cluster of clusters) {
      await breath();

      if (
        await this.consolidationRepo.candidateExists(ConsolidationKind.DISTILL, cluster.member_ids)
      ) {
        continue;
      }

      if (!(await this.holdLease())) {
        return;
      }

      const gen = await this.tryGenerate(
        {
          kind: ConsolidationKind.DISTILL,
          project: cluster.project,
          inputs: await this.consolidationRepo.candidateInputs(cluster.member_ids),
        },
        result,
      );

      // Provider judged these not worth consolidating -> record a dismissed candidate
      // (with the reason) so it is auditable and never re-proposed.
      if (gen?.recommendation === ConsolidationRecommendation.REJECT) {
        const id = await this.consolidationRepo.insertCandidate({
          kind: ConsolidationKind.DISTILL,
          project: cluster.project,
          member_ids: cluster.member_ids,
          score: cluster.score,
          proposal: gen,
          detected_at: now,
        });

        if (id) {
          await this.consolidationRepo.resolveCandidate(
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
        await this.nodesRepo.applyDistillation({
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

      const id = await this.consolidationRepo.insertCandidate({
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

    const breath = breather(this.batch.msPerBreath);

    for (const hit of hits) {
      await breath();

      const pair = await this.consolidationRepo.duplicatePairFor(hit.src, hit.dst, hit.score);

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
          inputs: await this.consolidationRepo.candidateInputs(pair.member_ids),
          canonical_id: pair.canonical_id,
        },
        result,
      );

      // Provider judged these distinct (not a true duplicate) -> dismiss with the reason.
      if (gen?.recommendation === ConsolidationRecommendation.REJECT) {
        const id = await this.consolidationRepo.insertCandidate({
          kind: ConsolidationKind.MERGE,
          project: pair.project,
          member_ids: pair.member_ids,
          canonical_id: pair.canonical_id,
          score: pair.score,
          proposal: gen,
          detected_at: now,
        });

        if (id) {
          await this.consolidationRepo.resolveCandidate(
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
        const recorded = await this.edgesRepo.insertDuplicateOfIfLive(
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

      const id = await this.consolidationRepo.insertCandidate({
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

  private async repointStranded(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.reattach === Posture.OFF) return;

    const breath = breather(this.batch.msPerBreath);

    for (const edge of await this.consolidationRepo.strandedSystemEdges(this.batch.repoint)) {
      await breath();

      const successors = await this.nodeReferences.terminalLiveSuccessors(edge.dst);

      if (successors.length !== 1) continue;

      const successor = successors[0]!;

      await this.edgesRepo.invalidateEdge(edge.src, edge.dst, edge.type, now);

      if (
        successor !== edge.src &&
        (await this.edgesRepo.insertSystemEdgeIfUnconnected(
          edge.type,
          edge.src,
          successor,
          this.ownerId,
          now,
          edge.weight,
        ))
      ) {
        result.integrity!.edges_repointed++;
        await this.logIntegrity(now, edge.src, {
          op: "repoint",
          relation: edge.type,
          from: edge.dst,
          to: successor,
        });
      }
    }
  }

  private async unlinkCrossProject(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.reattach === Posture.OFF) return;

    for (const edge of await this.consolidationRepo.crossProjectSystemLinks(this.batch.repoint)) {
      await this.edgesRepo.invalidateEdge(edge.src, edge.dst, edge.type, now);
      result.integrity!.links_dropped++;
      await this.logIntegrity(now, edge.src, {
        op: "drop",
        relation: edge.type,
        to: edge.dst,
        via: "cross-project",
      });
    }
  }

  private async reattach(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.reattach === Posture.OFF) return;

    const lonely = (
      await this.consolidationRepo.edgelessNodes(this.batch.reattach + this.unrelated.size)
    ).filter((node) => !this.unrelated.has(node.id));

    for (const node of lonely.slice(0, this.batch.reattach)) {
      if (node.kind === MemoryKind.EPISODIC) {
        const anchor = await this.consolidationRepo.anchorCheckpoint(node.id);

        if (
          anchor !== null &&
          (await this.edgesRepo.insertSystemEdgeIfUnconnected(
            EdgeType.RELATES_TO,
            node.id,
            anchor,
            this.ownerId,
            now,
            1,
          ))
        ) {
          result.integrity!.reattached++;
          await this.logIntegrity(now, node.id, {
            op: "reattach",
            relation: EdgeType.RELATES_TO,
            to: anchor,
            via: "checkpoint",
          });
          continue;
        }
      }

      if (!this.consolidator.enabled) continue;

      let failed = false;
      let attached = false;

      for (const nb of await this.consolidationRepo.neighboursOf(node.id, {
        minScore: 0,
        k: 40,
        capPerNode: REATTACH_CANDIDATES,
      })) {
        if (!(await this.holdLease())) return;

        const judged = await this.judge(node.id, nb.id, result);

        if (judged === null) {
          failed = true;
          continue;
        }

        if (judged.verdict.relation === LinkRelation.NONE) continue;

        await this.applyRelation(judged, nb.score, now, result);
        result.integrity!.reattached++;
        await this.logJudgement(now, "reattach", judged);
        attached = true;
        break;
      }

      if (!attached && !failed) this.unrelated.add(node.id);
    }
  }

  // `suggest` has nothing to review that `auto` does not already send there, so it acts as
  // `auto`.
  private async retypeLinks(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.retype === Posture.OFF) return;

    for (const link of await this.consolidationRepo.untypedLinks(this.batch.retype)) {
      if (link.connected) {
        await this.edgesRepo.invalidateEdge(link.src, link.dst, EdgeType.SIMILAR_TO, now);
        result.integrity!.links_dropped++;
        await this.logIntegrity(now, link.src, { op: "drop", to: link.dst, via: "redundant" });
        continue;
      }

      if (!this.consolidator.enabled) continue;
      if (!(await this.holdLease())) return;

      const judged = await this.judge(link.src, link.dst, result);

      if (judged === null) continue;

      await this.edgesRepo.invalidateEdge(link.src, link.dst, EdgeType.SIMILAR_TO, now);
      await this.logJudgement(now, "retype", judged);

      if (judged.verdict.relation === LinkRelation.NONE) {
        result.integrity!.links_dropped++;
        continue;
      }

      await this.applyRelation(judged, link.weight, now, result);
      result.integrity!.links_typed++;
    }
  }

  // A typed link is judged again once either note has been revised since it was made or last
  // confirmed; a references link the source still states as a [[wikilink]] needs no model.
  private async recheckLinks(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.retype === Posture.OFF) return;

    const links = await this.consolidationRepo.revisedLinks(this.batch.retype);

    if (!links.length) return;

    const stated = await this.statedReferences(links);

    for (const link of links) {
      if (stated.has(`${link.src}\0${link.dst}`)) {
        await this.consolidationRepo.markLinkChecked(link.src, link.dst, link.type, now);
        continue;
      }

      if (!this.consolidator.enabled) continue;
      if (!(await this.holdLease())) return;

      const judged = await this.judge(link.src, link.dst, result);

      if (judged === null) continue;

      await this.logJudgement(now, "recheck", judged);

      const { relation, from } = judged.verdict;
      const holds =
        (link.type === EdgeType.RELATES_TO && relation === LinkRelation.RELATES_TO) ||
        (link.type === EdgeType.REFERENCES && relation === LinkRelation.REFERENCES && from === "a");

      if (holds) {
        await this.consolidationRepo.markLinkChecked(link.src, link.dst, link.type, now);
        continue;
      }

      await this.edgesRepo.invalidateEdge(link.src, link.dst, link.type, now);

      if (relation === LinkRelation.NONE) {
        result.integrity!.links_dropped++;
        continue;
      }

      await this.applyRelation(judged, link.weight, now, result);
      result.integrity!.links_typed++;
    }
  }

  // The model picks what a dangling title link meant. Under `auto` a confident pick is acted
  // on; anything else waits on the Review tab with the pick.
  private async resolveWikilinks(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.wikilinks === Posture.OFF || !this.consolidator.enabled) return;

    const judged = new Map(
      (await this.consolidationRepo.wikilinkVerdicts()).map((v) => [
        `${v.node_id}\0${v.link}`,
        v.rev,
      ]),
    );
    const pending = (await this.danglers.scan()).danglers.filter(
      (d) => judged.get(`${d.body.id}\0${d.link.slug}`) !== d.body.rev,
    );

    this.wikilinkBacklog = pending.length;

    for (const dangler of pending.slice(0, this.batch.wikilinks)) {
      if (!(await this.holdLease())) return;

      const candidates = await this.linkCandidates(dangler);
      let verdict: ResolveLinkResult;

      if (!candidates.length) {
        verdict = { target_id: null, confidence: LinkConfidence.LOW, reason: "no candidate notes" };
      } else {
        try {
          verdict = await this.consolidator.resolveLink({
            project: dangler.body.project,
            link: dangler.link.raw,
            note: {
              title: dangler.body.title,
              context: wikilinkContext(dangler.body.content, dangler.link.raw),
            },
            candidates,
          });
        } catch (err) {
          result.generation_failures++;
          result.last_error = errorText(err);
          continue;
        }
      }

      this.wikilinkBacklog--;

      const action = await this.applyLinkVerdict(dangler, verdict, now, result);
      const target = candidates.find((c) => c.id === verdict.target_id);

      await this.consolidationRepo.saveWikilinkVerdict({
        node_id: dangler.body.id,
        link: dangler.link.slug,
        rev: dangler.body.rev,
        target_id: verdict.target_id,
        confidence: verdict.confidence,
        reason: verdict.reason,
        judged_at: now,
      });
      await this.logIntegrity(now, dangler.body.id, {
        op: "wikilink",
        relation: action,
        link: dangler.link.raw,
        to: verdict.target_id,
        titles: [dangler.body.title.slice(0, 80), ...(target ? [target.title.slice(0, 80)] : [])],
        confidence: verdict.confidence,
        reason: verdict.reason,
      });
    }
  }

  private async applyLinkVerdict(
    dangler: Dangler,
    verdict: ResolveLinkResult,
    now: string,
    result: ConsolidationTickResult,
  ): Promise<"rewrite" | "unlink" | "link" | "ignore" | "review"> {
    const integrity = result.integrity!;

    if (verdict.confidence !== LinkConfidence.HIGH || this.posture.wikilinks !== Posture.AUTO) {
      integrity.wikilinks_to_review!++;
      return "review";
    }

    const { body, link } = dangler;

    try {
      if (body.kind === MemoryKind.SEMANTIC) {
        await this.danglers.rewrite({
          node_id: body.id,
          link: link.raw,
          target: verdict.target_id,
          session_id: this.ownerId,
          via: "sweep",
          ts: now,
        });
        body.rev++;
      } else {
        if (verdict.target_id !== null) {
          await this.edgesRepo.insertSystemReferenceIfUnconnected(
            body.id,
            verdict.target_id,
            this.ownerId,
            now,
          );
        }

        await this.consolidationRepo.ignoreWikilink(body.id, link.slug, now);
      }
    } catch (err) {
      result.last_error = errorText(err);
      integrity.wikilinks_to_review!++;
      return "review";
    }

    if (verdict.target_id === null) {
      integrity.wikilinks_unlinked!++;
      return body.kind === MemoryKind.SEMANTIC ? "unlink" : "ignore";
    }

    integrity.wikilinks_fixed!++;
    return body.kind === MemoryKind.SEMANTIC ? "rewrite" : "link";
  }

  // What the link may have meant: the ambiguous matches, notes whose text matches the link,
  // and the note's own nearest neighbours.
  private async linkCandidates(dangler: Dangler): Promise<LinkCandidate[]> {
    const ids = new Set(dangler.candidates);

    for (const match of await this.danglers.textMatches(dangler)) ids.add(match.id);

    for (const nb of await this.consolidationRepo.neighboursOf(dangler.body.id, {
      minScore: 0,
      k: 20,
      capPerNode: LINK_NEIGHBOURS,
    })) {
      ids.add(nb.id);
    }

    ids.delete(dangler.body.id);

    return (await this.consolidationRepo.relationInputs([...ids].slice(0, LINK_CANDIDATES))).map(
      (input) => ({ id: input.id, title: input.title, type: input.type, content: input.content }),
    );
  }

  private async statedReferences(links: { src: string; type: EdgeType }[]): Promise<Set<string>> {
    const sources = new Set(links.filter((l) => l.type === EdgeType.REFERENCES).map((l) => l.src));
    const stated = new Set<string>();

    if (!sources.size) return stated;

    const bodies = await this.consolidationRepo.authoredBodies();
    const index = await this.wikilinks.index(bodies);

    for (const body of bodies) {
      if (!sources.has(body.id)) continue;

      for (const target of wikilinkTargets(body.content)) {
        const outcome = await index.resolve(target);

        if ("id" in outcome) stated.add(`${body.id}\0${outcome.id}`);
      }
    }

    return stated;
  }

  private async logJudgement(now: string, op: string, { a, b, verdict }: Judgement) {
    const [from, to] = verdict.from === "a" ? [a, b] : [b, a];

    await this.logIntegrity(now, from.id, {
      op,
      relation: verdict.relation,
      to: to.id,
      titles: [from.title.slice(0, 80), to.title.slice(0, 80)],
      reason: verdict.reason,
    });
  }

  private async logIntegrity(now: string, nodeId: string, detail: Record<string, unknown>) {
    await this.sessionsRepo.logEvent(
      EventAction.GRAPH_INTEGRITY,
      this.ownerId,
      nodeId,
      detail,
      now,
    );
    this.feed.publish({
      id: null,
      ts: now,
      action: EventAction.GRAPH_INTEGRITY,
      session_id: this.ownerId,
      node_id: nodeId,
      principal: this.principal,
      client: CONSOLIDATION_WRITER.client,
      ok: true,
      detail,
    });
  }

  private async judge(
    aId: string,
    bId: string,
    result: ConsolidationTickResult,
  ): Promise<Judgement | null> {
    const [a, b] = await this.consolidationRepo.relationInputs([aId, bId]);

    if (!a || !b) return null;

    try {
      const verdict = await this.consolidator.relate({
        project: a.project ?? b.project,
        a: { title: a.title, type: a.type, created_at: a.created_at, content: a.content },
        b: { title: b.title, type: b.type, created_at: b.created_at, content: b.content },
      });

      return { a, b, verdict };
    } catch (err) {
      result.generation_failures++;
      result.last_error = errorText(err);

      return null;
    }
  }

  private async applyRelation(
    { a, b, verdict }: Judgement,
    weight: number,
    now: string,
    result: ConsolidationTickResult,
  ): Promise<void> {
    const [from, to] = verdict.from === "a" ? [a, b] : [b, a];
    const edge = (type: EdgeType, src: string, dst: string) =>
      this.edgesRepo.insertSystemEdgeIfUnconnected(type, src, dst, this.ownerId, now, weight);

    if (verdict.relation === LinkRelation.REFERENCES) {
      await edge(EdgeType.REFERENCES, from.id, to.id);
      return;
    }

    await edge(EdgeType.RELATES_TO, a.id, b.id);

    if (verdict.relation === LinkRelation.DUPLICATE_OF) {
      const id = await this.consolidationRepo.insertCandidate({
        kind: ConsolidationKind.MERGE,
        project: to.project,
        member_ids: [from.id, to.id],
        canonical_id: to.id,
        score: weight,
        detected_at: now,
      });

      if (id) result.integrity!.links_to_review++;
    }

    if (verdict.relation !== LinkRelation.SUPERSEDES) return;

    if (this.posture.supersede === Posture.AUTO) {
      await this.supersede(to.id, from.id, verdict.reason, now, result);
      return;
    }

    if (this.posture.supersede === Posture.OFF) return;

    const id = await this.consolidationRepo.insertCandidate({
      kind: ConsolidationKind.SUPERSEDE,
      project: from.project,
      member_ids: [to.id, from.id],
      canonical_id: from.id,
      score: weight,
      proposal: {
        recommendation: ConsolidationRecommendation.APPLY,
        reason: verdict.reason,
        title: from.title,
        summary: "",
        body: "",
      },
      detected_at: now,
    });

    if (id) result.integrity!.links_to_review++;
  }

  private async settleSupersedes(now: string, result: ConsolidationTickResult): Promise<void> {
    if (this.posture.supersede !== Posture.AUTO) return;

    const pending = await this.consolidationRepo.pendingCandidates({
      kind: ConsolidationKind.SUPERSEDE,
      limit: this.batch.retype,
    });

    for (const cand of pending) {
      const [older, newer] = cand.member_ids;
      const done =
        older && newer
          ? await this.supersede(older, newer, cand.proposal?.reason ?? null, now, result)
          : false;

      await this.consolidationRepo.resolveCandidate(
        cand.id,
        done ? ConsolidationStatus.APPLIED : ConsolidationStatus.DISMISSED,
        this.ownerId,
        now,
      );
    }
  }

  private async supersede(
    older: string,
    newer: string,
    reason: string | null,
    now: string,
    result: ConsolidationTickResult,
  ): Promise<boolean> {
    if (
      (await this.nodesRepo.referenceState(older)) !== "live" ||
      (await this.nodesRepo.referenceState(newer)) !== "live"
    ) {
      return false;
    }

    const inputs = await this.consolidationRepo.relationInputs([older, newer]);
    const title = (id: string) => inputs.find((n) => n.id === id)?.title.slice(0, 80) ?? "";
    const detail = {
      op: "supersede",
      to: newer,
      titles: [title(older), title(newer)],
      reason,
    };
    const kept = await this.protection.handMaintained(older);

    if (kept) {
      await this.logIntegrity(now, older, { ...detail, kept: "hand-maintained", ...kept });
      return false;
    }

    await this.nodesRepo.invalidateNode(older, {
      ts: now,
      superseded_by: newer,
      session_id: this.ownerId,
    });
    await this.logIntegrity(now, older, detail);
    result.integrity!.superseded = (result.integrity!.superseded ?? 0) + 1;

    return true;
  }

  // Backfill proposals for pending distill/merge candidates that were queued before a
  // generation provider was available (e.g., detected under `manual`, then switched to
  // `http`). Provider-gated; leaves a candidate untouched on generation failure (retried
  // next sweep). Bounded by `backfillBatch` so a tick stays reasonable.
  // Whether a generating sweep has queued work left: a proposal to write or a note to
  // annotate. Detection is cheap and runs on the interval; this is what keeps the model busy
  // between intervals.
  async hasGenerativeWork(): Promise<boolean> {
    if (!this.consolidator.enabled) return false;

    if ((await this.consolidationRepo.pendingNeedingProposal(1)).length > 0) return true;

    if (this.posture.wikilinks !== Posture.OFF && this.wikilinkBacklog > 0) return true;

    if (
      this.posture.retype !== Posture.OFF &&
      ((await this.consolidationRepo.untypedLinks(1)).length > 0 ||
        (await this.consolidationRepo.revisedLinks(1)).length > 0)
    ) {
      return true;
    }

    return (
      this.posture.annotate !== Posture.OFF &&
      (await this.consolidationRepo.unannotatedSemantic(1)).length > 0
    );
  }

  private async backfillProposals(now: string, result: ConsolidationTickResult): Promise<void> {
    if (!this.consolidator.enabled) {
      return;
    }

    for (const cand of await this.consolidationRepo.pendingNeedingProposal(this.batch.backfill)) {
      if (!(await this.holdLease())) {
        return;
      }

      if (cand.kind !== ConsolidationKind.DISTILL && cand.kind !== ConsolidationKind.MERGE) {
        continue;
      }

      const inputs = await this.consolidationRepo.candidateInputs(cand.member_ids);

      if (!inputs.length) {
        continue;
      }

      const gen = await this.tryGenerate(
        { kind: cand.kind, project: cand.project, inputs, canonical_id: cand.canonical_id },
        result,
      );

      if (!gen) {
        continue; // generation failed -> leave for a later sweep
      }

      await this.consolidationRepo.setCandidateProposal(cand.id, gen);

      // Store the verdict either way; auto-dismiss the ones judged not worth consolidating,
      // so the Review inbox surfaces only genuine duplicates.
      if (gen.recommendation === ConsolidationRecommendation.REJECT) {
        await this.consolidationRepo.resolveCandidate(
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
  // Repos whose root is no longer on disk. Their symbols cannot be re-verified against
  // source, but neither were they deleted from it — the checkout moved, the volume is
  // unmounted, or the remembered root is stale — so the prune must leave them alone.
  private async unreachableRepos(): Promise<string[]> {
    return (await this.codeRepo.storedRepoRoots())
      .filter((repo) => !existsSync(repo.root))
      .map((repo) => repo.name);
  }

  private async pruneMirrors(now: string, result: ConsolidationTickResult): Promise<void> {
    const posture = this.posture.prune;

    if (posture === Posture.OFF) {
      return;
    }

    const watermark = await this.consolidationRepo.codeIndexWatermark();

    if (this.lastOrphanScan?.clean === true && this.lastOrphanScan.watermark === watermark) {
      return;
    }

    const dead = await this.consolidationRepo.deadMirrorNodes(
      this.batch.prune,
      await this.unreachableRepos(),
    );

    // Not clean means the batch limit may have truncated the list, so the next sweep looks
    // again whatever the watermark says.
    this.lastOrphanScan = { watermark, clean: dead.length === 0 };

    const breath = breather(this.batch.msPerBreath);

    for (const id of dead) {
      await breath();

      if (posture === Posture.AUTO) {
        await this.nodesRepo.invalidateNode(id, { ts: now, session_id: this.ownerId });
        result.pruned++;
      } else {
        const cid = await this.consolidationRepo.insertCandidate({
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

    for (const node of await this.consolidationRepo.unannotatedSemantic(this.batch.annotate)) {
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

      const ok = await this.nodesRepo.applyAnnotation({
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
