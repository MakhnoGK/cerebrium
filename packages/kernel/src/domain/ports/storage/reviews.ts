import type { ReviewArtifact, ReviewDecision } from "@cerebrium/contracts/vocab";

// Which principals' writes are under review. `only` lists them; `except` is everyone but
// the listed ones, which is what a deployment whose DEFAULT profile is `suggest` needs —
// there is no table of principals to enumerate, only the ones config names.
export interface ReviewScope {
  mode: "only" | "except";
  principals: readonly string[];
}

export interface ReviewNodeStub {
  id: string;
  type: string;
  title: string;
}

export interface PendingEdge {
  ref: string;
  edge_type: string;
  at: string;
  principal: string | null;
  src: ReviewNodeStub;
  dst: ReviewNodeStub;
}

export interface PendingNode {
  ref: string;
  at: string;
  principal: string | null;
  node: ReviewNodeStub;
}

export interface RecordedDecision {
  artifact: ReviewArtifact;
  ref: string;
  decision: ReviewDecision;
  decided_at: string;
  decided_by: string | null;
  note: string | null;
}

export const EDGE_REF_SEPARATOR = "|";

export function edgeRef(src: string, dst: string, type: string): string {
  return [src, dst, type].join(EDGE_REF_SEPARATOR);
}

export function parseEdgeRef(ref: string): { src: string; dst: string; type: string } | null {
  const parts = ref.split(EDGE_REF_SEPARATOR);

  return parts.length === 3 && parts.every((p) => p.length > 0)
    ? { src: parts[0]!, dst: parts[1]!, type: parts[2]! }
    : null;
}

export const REVIEWS_REPO_TOKEN = Symbol("ReviewsRepo");

export interface ReviewsRepo {
  pendingEdges(scope: ReviewScope, limit: number): Promise<PendingEdge[]>;
  pendingNodes(scope: ReviewScope, limit: number): Promise<PendingNode[]>;
  pendingCount(scope: ReviewScope): Promise<{ edges: number; nodes: number }>;
  decisionFor(artifact: ReviewArtifact, ref: string): Promise<RecordedDecision | null>;
  record(entry: RecordedDecision): Promise<void>;
  counts(): Promise<Record<string, number>>;
}
