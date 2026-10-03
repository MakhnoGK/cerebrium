import { createHash } from "node:crypto";
import type {
  ConsolidationCandidate,
  ConsolidationProposal,
  NewCandidate,
} from "@cerebrium/contracts/types";
import type {
  ConsolidationKind,
  ConsolidationStatus,
  EdgeType,
  MemoryKind,
} from "@cerebrium/contracts/vocab";
import type {
  ConsolidationReporter,
  ConsolidationTickResult,
} from "@/domain/ports/consolidation-reporter";

export interface SweepSeed {
  id: string;
  kind: MemoryKind;
  ordinal: number;
}

export interface DuplicatePair {
  member_ids: string[];
  canonical_id: string;
  project: string | null;
  score: number;
  same_session: boolean;
  youngest_created_at: string;
}

export interface EdgelessNode {
  id: string;
  kind: MemoryKind;
  project: string | null;
}

// `connected`: another live edge already joins the pair.
export interface UntypedLink {
  src: string;
  dst: string;
  weight: number;
  connected: boolean;
}

export interface RelationInput {
  id: string;
  title: string;
  type: string;
  project: string | null;
  created_at: string;
  content: string;
}

export interface StrandedEdge {
  src: string;
  dst: string;
  type: EdgeType;
  weight: number;
}

export interface AuthoredBody {
  id: string;
  kind: MemoryKind;
  title: string;
  project: string | null;
  rev: number;
  content: string;
}

export interface WikilinkVerdictRow {
  node_id: string;
  link: string;
  rev: number;
  target_id: string | null;
  confidence: string;
  reason: string;
  judged_at: string;
}

export type ResolvedStatus = Exclude<ConsolidationStatus, ConsolidationStatus.PENDING>;

// Idempotency key: a cluster is the same regardless of member order, so hash the
// kind with the sorted ids. Re-detecting an existing cluster (pending, applied, or
// dismissed) collides on UNIQUE(member_hash) and is ignored — never re-proposed.
export function candidateHash(kind: ConsolidationKind, memberIds: string[]): string {
  const key = `${kind}\0${[...memberIds].sort().join("\0")}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// Canonical orientation for a symmetric pair, so (a,b) and (b,a) dedupe to one key and
// one stored edge (graph expansion via neighborsOf is symmetric, so one direction suffices).
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

export const CONSOLIDATION_REPO_TOKEN = Symbol("ConsolidationRepo");

export interface ConsolidationRepo extends ConsolidationReporter {
  insertCandidate(input: NewCandidate): Promise<string | null>;
  candidateExists(kind: ConsolidationKind, memberIds: string[]): Promise<boolean>;
  pendingNeedingProposal(limit: number): Promise<ConsolidationCandidate[]>;
  setCandidateProposal(id: string, proposal: ConsolidationProposal): Promise<boolean>;
  getCandidate(id: string): Promise<ConsolidationCandidate | undefined>;
  pendingCandidateCount(): Promise<number>;
  pendingCandidates(opts?: {
    kind?: ConsolidationKind;
    limit?: number;
  }): Promise<ConsolidationCandidate[]>;
  pendingCandidatePage(opts: {
    kind?: ConsolidationKind;
    limit: number;
    after?: { score: number; detected_at: string; id: string };
  }): Promise<ConsolidationCandidate[]>;
  sweepSeeds(limit: number): Promise<SweepSeed[]>;
  neighboursOf(
    seedId: string,
    opts: { minScore: number; k?: number; capPerNode?: number },
  ): Promise<{ id: string; score: number }[]>;
  storedSimilarPairs(): Promise<Set<string>>;
  linkDegrees(ids: string[]): Promise<Map<string, number>>;
  overCapSimilarLinks(opts: {
    maxDegree: number;
    limit: number;
  }): Promise<{ src: string; dst: string }[]>;
  candidateInputs(ids: string[]): Promise<{ id: string; title: string; content: string }[]>;
  // Live authored nodes with no live edge to another live authored node.
  edgelessNodes(limit: number): Promise<EdgelessNode[]>;
  // The checkpoint of the node's own session within its project family, else the newest
  // earlier one of its project.
  anchorCheckpoint(id: string): Promise<string | null>;
  // Live similar_to edges between live authored nodes, strongest first.
  untypedLinks(limit: number): Promise<UntypedLink[]>;
  relationInputs(ids: string[]): Promise<RelationInput[]>;
  // Live system edges from a live authored node into a retired one that has a superseder.
  strandedSystemEdges(limit: number): Promise<StrandedEdge[]>;
  // Live system relates_to/references edges between live authored nodes where either end got
  // a revision after the edge was made or last confirmed.
  revisedLinks(limit: number): Promise<StrandedEdge[]>;
  markLinkChecked(src: string, dst: string, type: EdgeType, ts: string): Promise<void>;
  // Live system similar_to/relates_to edges between authored nodes of different project
  // families.
  crossProjectSystemLinks(limit: number): Promise<StrandedEdge[]>;
  staleEpisodicClusters(opts: {
    minScore: number;
    minCluster: number;
    cutoff: string;
    limit: number;
    k?: number;
    capPerNode?: number;
  }): Promise<{ project: string | null; member_ids: string[]; score: number }[]>;
  duplicatePairFor(a: string, b: string, score: number): Promise<DuplicatePair | null>;
  citableSymbols(): Promise<{ name: string; node_id: string; repo: string }[]>;
  authoredBodies(): Promise<AuthoredBody[]>;
  revisionCount(): Promise<number>;
  retiredAuthoredTitles(): Promise<{ id: string; title: string }[]>;
  // Titles a live authored node carried before its current one.
  formerTitles(): Promise<{ id: string; title: string }[]>;
  ignoredWikilinks(): Promise<{ node_id: string; link: string }[]>;
  ignoreWikilink(nodeId: string, link: string, ts: string): Promise<void>;
  wikilinkVerdicts(): Promise<WikilinkVerdictRow[]>;
  saveWikilinkVerdict(row: WikilinkVerdictRow): Promise<void>;
  // Marks the node's live system relates_to/references edges that have nothing left to
  // re-check as checked at `ts`, so a revision at `ts` does not queue them again.
  confirmSettledLinks(nodeId: string, ts: string): Promise<void>;
  codeIndexWatermark(): Promise<string | null>;
  deadMirrorNodes(limit: number, unreachable?: readonly string[]): Promise<string[]>;
  unannotatedSemantic(
    limit: number,
  ): Promise<{ id: string; rev: number; title: string; content: string; project: string | null }[]>;
  resolveCandidate(
    id: string,
    status: ResolvedStatus,
    resolvedBy: string,
    ts: string,
  ): Promise<boolean>;
  resolvePendingByMembers(
    kind: ConsolidationKind,
    memberIds: string[],
    status: ResolvedStatus,
    resolvedBy: string,
    ts: string,
  ): Promise<boolean>;
  // Dismisses every pending candidate one of whose members has been retired since it was
  // detected. Returns how many.
  dismissRetiredCandidates(resolvedBy: string, ts: string): Promise<number>;
  // Runs `operation` and the candidate's resolution in one transaction, so the writes it
  // performs through other repositories commit or roll back together with it.
  resolveCandidateAtomically(
    id: string,
    resolvedBy: string,
    ts: string,
    operation: (candidate: ConsolidationCandidate) => Promise<ResolvedStatus>,
  ): Promise<{ candidate: ConsolidationCandidate; status: ResolvedStatus } | null>;
  reportTick(runId: string, result: ConsolidationTickResult): Promise<void>;
  closeRun(runId: string, at: string, reason: string): Promise<void>;
  closeAbandonedRuns(reason: string): Promise<number>;
  clearCandidateProposal(id: string, error: string | null): Promise<void>;
  reopenCandidate(id: string): Promise<void>;
}
