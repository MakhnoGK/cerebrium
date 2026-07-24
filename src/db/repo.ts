import type Database from "better-sqlite3";
import type { ConsolidationKind, ConsolidationStatus, EdgeType, EventAction } from "@/core/vocab";
import type {
  ConsolidationCandidate,
  ConsolidationProposal,
  Envelope,
  FileIndexInput,
  FileIndexResult,
  MirrorItem,
  MirrorRecord,
  MirrorSource,
  MirrorSourceStatus,
  MirrorUpsertResult,
  Neighbor,
  NeighborStub,
  NewCandidate,
  NewNode,
  QueueRow,
  RepoProvenance,
  RevisionMeta,
  SearchRow,
  SymbolDirEntry,
  SymbolFacets,
  SymbolLookup,
  TechStats,
  UnembeddedChunk,
  VectorRow,
} from "@/core/types";
import {
  CodeRepo,
  ConsolidationRepo,
  EdgesRepo,
  EmbeddingQueueRepo,
  MirrorRepo,
  NodesRepo,
  SearchRepo,
  SessionsRepo,
  StatsRepo,
} from "@/db/repositories";

// Domain types + pure mappers live in core; re-exported here so existing
// `@/db/repo` importers keep resolving.
export type {
  Envelope,
  NeighborStub,
  RevisionMeta,
  EnrichedRow,
  SearchRow,
  VectorRow,
  QueueRow,
  UnembeddedChunk,
  TechStats,
  RepoProvenance,
  Neighbor,
  NewNode,
  ExtractedSymbol,
  FileIndexInput,
  FileIndexResult,
  SymbolDirEntry,
  SymbolFacets,
  SymbolLookup,
  MirrorSource,
  MirrorSourceStatus,
  MirrorItem,
  MirrorUpsertResult,
  MirrorRecord,
  ConsolidationCandidate,
  ConsolidationProposal,
  NewCandidate,
} from "@/core/types";
export { toEnvelope, deriveSummary } from "@/core/types";

// Composition root over the per-aggregate repositories. It owns the single
// connection, wires the repos in dependency order, and delegates the public data-
// access surface to them. The append-only-revisions and FTS-in-write-transaction
// invariants live inside the sub-repos (nodes/code + internal), never here.
export class Repo {
  private readonly sessions: SessionsRepo;
  private readonly edges: EdgesRepo;
  private readonly nodes: NodesRepo;
  private readonly queue: EmbeddingQueueRepo;
  private readonly retrieval: SearchRepo;
  private readonly code: CodeRepo;
  private readonly mirror: MirrorRepo;
  private readonly consolidation: ConsolidationRepo;
  private readonly statsRepo: StatsRepo;

  constructor(db: Database.Database) {
    this.sessions = new SessionsRepo(db);
    this.edges = new EdgesRepo(db);
    this.nodes = new NodesRepo(db, this.edges);
    this.queue = new EmbeddingQueueRepo(db);
    this.retrieval = new SearchRepo(db);
    this.code = new CodeRepo(db, this.edges);
    this.mirror = new MirrorRepo(db);
    this.consolidation = new ConsolidationRepo(db);
    this.statsRepo = new StatsRepo(db, this.queue, this.code);
  }

  // ---- sessions ------------------------------------------------------------
  ensureSession(id: string, project: string | null, ts: string): { created: boolean } {
    return this.sessions.ensureSession(id, project, ts);
  }
  logEvent(
    action: EventAction,
    session_id: string,
    node_id: string | null,
    detail: unknown,
    ts: string,
  ): void {
    this.sessions.logEvent(action, session_id, node_id, detail, ts);
  }

  // ---- nodes ---------------------------------------------------------------
  nodeExists(id: string): boolean {
    return this.nodes.nodeExists(id);
  }
  nodeOrigin(id: string): { memory_kind: string; origin: string | null } | undefined {
    return this.nodes.nodeOrigin(id);
  }
  envelope(id: string): Envelope | undefined {
    return this.nodes.envelope(id);
  }
  fullNode(id: string): { envelope: Envelope; content: string; edges: NeighborStub[] } | undefined {
    return this.nodes.fullNode(id);
  }
  listRevisions(id: string): RevisionMeta[] {
    return this.nodes.listRevisions(id);
  }
  revisionContent(id: string, rev: number): string | undefined {
    return this.nodes.revisionContent(id, rev);
  }
  createNode(input: NewNode): Envelope {
    return this.nodes.createNode(input);
  }
  addRevision(
    id: string,
    fields: {
      content?: string;
      title?: string;
      session_id: string;
      reason: string | null;
      ts: string;
    },
  ): Envelope {
    return this.nodes.addRevision(id, fields);
  }
  invalidateNode(
    id: string,
    fields: { ts: string; superseded_by?: string; session_id: string },
  ): Envelope {
    return this.nodes.invalidateNode(id, fields);
  }
  applyDistillation(input: {
    title: string;
    content: string;
    project: string | null;
    sourceIds: string[];
    session_id: string;
    ts: string;
  }): Envelope {
    return this.nodes.applyDistillation(input);
  }
  applyMerge(input: {
    survivorId: string;
    loserId: string;
    session_id: string;
    ts: string;
    merged?: { title: string; body: string };
  }): Envelope {
    return this.nodes.applyMerge(input);
  }
  applyAnnotation(input: {
    nodeId: string;
    rev: number;
    annotationsJson: string;
    ftsText: string;
    ts: string;
  }): boolean {
    return this.nodes.applyAnnotation(input);
  }

  // ---- edges ---------------------------------------------------------------
  insertEdge(
    src: string,
    dst: string,
    type: EdgeType,
    provenance: "agent" | "system",
    session_id: string,
    ts: string,
    weight = 1.0,
  ): void {
    this.edges.insertEdge(src, dst, type, provenance, session_id, ts, weight);
  }
  edgesOf(id: string): NeighborStub[] {
    return this.edges.edgesOf(id);
  }
  neighborsOf(parentIds: string[]): Neighbor[] {
    return this.edges.neighborsOf(parentIds);
  }
  supersededInfo(ids: string[]): Map<string, { by: string; at: string }> {
    return this.edges.supersededInfo(ids);
  }

  // ---- embedding queue -----------------------------------------------------
  queueRows(limit: number): QueueRow[] {
    return this.queue.queueRows(limit);
  }
  unembeddedChunks(nodeIds: string[], limit: number): UnembeddedChunk[] {
    return this.queue.unembeddedChunks(nodeIds, limit);
  }
  commitNodeEmbeddings(
    nodeId: string,
    items: { chunkId: string; vector: number[] }[],
    model: string,
    version: string,
    ts: string,
  ): void {
    this.queue.commitNodeEmbeddings(nodeId, items, model, version, ts);
  }
  commitBatchEmbeddings(
    batch: { nodeId: string; items: { chunkId: string; vector: number[] }[] }[],
    model: string,
    version: string,
    ts: string,
  ): void {
    this.queue.commitBatchEmbeddings(batch, model, version, ts);
  }
  finalizeNode(nodeId: string, ts: string): void {
    this.queue.finalizeNode(nodeId, ts);
  }
  recordEmbeddingFailure(nodeIds: string[], error: string, ts: string): void {
    this.queue.recordEmbeddingFailure(nodeIds, error, ts);
  }
  holdWorkerLease(role: string, owner: string, ttlMs: number, now: string): boolean {
    return this.queue.holdWorkerLease(role, owner, ttlMs, now);
  }
  releaseWorkerLease(role: string, owner: string): void {
    this.queue.releaseWorkerLease(role, owner);
  }
  reconcilePending(ts: string): void {
    this.queue.reconcilePending(ts);
  }
  embeddingStats(): { backlog: number; parked: number } {
    return this.queue.embeddingStats();
  }

  // ---- retrieval + working set ---------------------------------------------
  vectorSearch(
    embedding: number[],
    opts: { project?: string; kinds?: string[]; types?: string[]; history: boolean; cap: number },
  ): VectorRow[] {
    return this.retrieval.vectorSearch(embedding, opts);
  }
  search(opts: {
    match: string;
    project?: string;
    kinds?: string[];
    types?: string[];
    history: boolean;
    cap: number;
  }): { rows: SearchRow[]; total: number } {
    return this.retrieval.search(opts);
  }
  validSemantic(project: string | undefined, limit: number): Envelope[] {
    return this.retrieval.validSemantic(project, limit);
  }
  lastCheckpoints(
    project: string | undefined,
    limit: number,
  ): { envelope: Envelope; content: string }[] {
    return this.retrieval.lastCheckpoints(project, limit);
  }
  validTasks(project: string | undefined, limit: number): Envelope[] {
    return this.retrieval.validTasks(project, limit);
  }
  recentValid(project: string | undefined, limit: number): Envelope[] {
    return this.retrieval.recentValid(project, limit);
  }

  // ---- code ----------------------------------------------------------------
  codeFileHash(repo: string, path: string): string | undefined {
    return this.code.codeFileHash(repo, path);
  }
  listCodeFilePaths(repo: string): string[] {
    return this.code.listCodeFilePaths(repo);
  }
  applyFileIndex(input: FileIndexInput): FileIndexResult {
    return this.code.applyFileIndex(input);
  }
  repoSymbolDirectory(repo: string): SymbolDirEntry[] {
    return this.code.repoSymbolDirectory(repo);
  }
  rebuildResolvedEdges(
    repo: string,
    path: string,
    type: EdgeType,
    pairs: { src: string; dst: string }[],
    session_id: string,
    ts: string,
  ): number {
    return this.code.rebuildResolvedEdges(repo, path, type, pairs, session_id, ts);
  }
  removeFile(repo: string, path: string, ts: string): number {
    return this.code.removeFile(repo, path, ts);
  }
  symbolDetail(nodeId: string): (SymbolFacets & { source: string }) | undefined {
    return this.code.symbolDetail(nodeId);
  }
  findSymbolsByName(name: string, repo: string | undefined, limit: number): SymbolLookup[] {
    return this.code.findSymbolsByName(name, repo, limit);
  }
  findSymbolsInFile(repo: string | undefined, path: string, limit: number): SymbolLookup[] {
    return this.code.findSymbolsInFile(repo, path, limit);
  }
  setRepoProvenance(
    repo: string,
    root: string | null,
    branch: string | null,
    commit: string | null,
    dirty: boolean,
    ts: string,
  ): void {
    this.code.setRepoProvenance(repo, root, branch, commit, dirty, ts);
  }
  repoProvenance(repo: string): RepoProvenance | undefined {
    return this.code.repoProvenance(repo);
  }
  storedRepoRoots(): { name: string; root: string }[] {
    return this.code.storedRepoRoots();
  }
  allRepoProvenance(): RepoProvenance[] {
    return this.code.allRepoProvenance();
  }

  // ---- external mirrors ----------------------------------------------------
  registerSource(input: {
    id: string;
    kind: string;
    label?: string | null;
    project?: string | null;
    freshness_hours?: number | null;
    recipe?: string | null;
    enabled?: boolean;
    ts: string;
  }): MirrorSource {
    return this.mirror.registerSource(input);
  }
  getSource(id: string): MirrorSource | undefined {
    return this.mirror.getSource(id);
  }
  listSources(): MirrorSource[] {
    return this.mirror.listSources();
  }
  sourceStatus(now: string, id?: string): MirrorSourceStatus[] {
    return this.mirror.sourceStatus(now, id);
  }
  upsertMirrors(
    source: MirrorSource,
    items: MirrorItem[],
    session_id: string,
    ts: string,
  ): MirrorUpsertResult {
    return this.mirror.upsertMirrors(source, items, session_id, ts);
  }
  mirrorRecord(nodeId: string): MirrorRecord | undefined {
    return this.mirror.mirrorRecord(nodeId);
  }

  // ---- consolidation queue -------------------------------------------------
  insertCandidate(input: NewCandidate): string | null {
    return this.consolidation.insertCandidate(input);
  }
  candidateExists(kind: ConsolidationKind, memberIds: string[]): boolean {
    return this.consolidation.candidateExists(kind, memberIds);
  }
  pendingNeedingProposal(limit: number): ConsolidationCandidate[] {
    return this.consolidation.pendingNeedingProposal(limit);
  }
  setCandidateProposal(id: string, proposal: ConsolidationProposal): boolean {
    return this.consolidation.setCandidateProposal(id, proposal);
  }
  similarLinkCandidates(opts: {
    minScore: number;
    k?: number;
    capPerNode?: number;
    limit: number;
  }): { src: string; dst: string; score: number }[] {
    return this.consolidation.similarLinkCandidates(opts);
  }
  staleEpisodicClusters(opts: {
    minScore: number;
    minCluster: number;
    cutoff: string;
    limit: number;
    k?: number;
    capPerNode?: number;
  }): { project: string | null; member_ids: string[]; score: number }[] {
    return this.consolidation.staleEpisodicClusters(opts);
  }
  candidateInputs(ids: string[]): { id: string; title: string; content: string }[] {
    return this.consolidation.candidateInputs(ids);
  }
  duplicateSemanticPairs(opts: {
    minScore: number;
    limit: number;
    k?: number;
    capPerNode?: number;
  }): { member_ids: string[]; canonical_id: string; project: string | null; score: number }[] {
    return this.consolidation.duplicateSemanticPairs(opts);
  }
  deadMirrorNodes(limit: number): string[] {
    return this.consolidation.deadMirrorNodes(limit);
  }
  unannotatedSemantic(
    limit: number,
  ): { id: string; rev: number; title: string; content: string; project: string | null }[] {
    return this.consolidation.unannotatedSemantic(limit);
  }
  getCandidate(id: string): ConsolidationCandidate | undefined {
    return this.consolidation.getCandidate(id);
  }
  pendingCandidates(opts?: { kind?: ConsolidationKind; limit?: number }): ConsolidationCandidate[] {
    return this.consolidation.pendingCandidates(opts);
  }
  resolveCandidate(
    id: string,
    status: Exclude<ConsolidationStatus, "pending">,
    resolvedBy: string,
    ts: string,
  ): boolean {
    return this.consolidation.resolveCandidate(id, status, resolvedBy, ts);
  }

  // ---- stats ---------------------------------------------------------------
  stats(): {
    nodes_by_kind: Record<string, number>;
    last_activity: string | null;
    embedding: { backlog: number; parked: number };
  } {
    return this.statsRepo.stats();
  }
  dbPath(): string {
    return this.statsRepo.dbPath();
  }
  techStats(now: string): TechStats {
    return this.statsRepo.techStats(now);
  }
}
