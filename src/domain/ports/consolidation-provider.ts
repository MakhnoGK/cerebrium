import { ConsolidationKind } from "@/core/vocab";

export const CONSOLIDATION_PROVIDER_TOKEN = Symbol("consolidator-token");

// Only distill/merge ever reach a generation provider — link and prune are
// deterministic and never call one. Narrowing here keeps an unrepresentable task
// unrepresentable, rather than relying on every caller to check.
export type GenerationTaskKind = ConsolidationKind.DISTILL | ConsolidationKind.MERGE;

// A pluggable generation backend for consolidation (`generate`), the write-time dedup
// judgment (`reconcile`), and attribute enrichment (`annotate`). `manual`/`off` report
// `enabled=false` and are never asked to do any of them (the daemon queues clusters for
// an agent; the write tool falls back to its advisory `similar_existing` hint; nodes
// stay un-annotated); real providers (`command`/`http`) run autonomously. Mirrors
// RerankProvider: the interface is the whole contract, so a new backend is a one-file change.
export interface ConsolidationProvider {
  readonly name: string;
  readonly version: string;
  readonly enabled: boolean;

  generate(task: ConsolidationTask): Promise<ConsolidationResult>;
  reconcile(task: ReconcileTask): Promise<ReconcileResult>;
  annotate(task: AnnotateTask): Promise<AnnotateResult>;
}

// A generation task handed to a ConsolidationProvider: a cluster of records to fold
// into ONE durable semantic fact (distill) or a merged canonical note (merge). The
// provider only produces text — the daemon (the single writer) performs the DB write.
export interface ConsolidationTask {
  kind: GenerationTaskKind;
  project: string | null;
  inputs: ConsolidationTaskInput[];
}

export interface ConsolidationTaskInput {
  id: string;
  title: string;
  content: string;
}

// The generated result: a JUDGMENT plus the drafted consolidation. `recommendation` is
// the provider's verdict on whether these records should actually be consolidated —
// detection only measures similarity, which yields false positives (two different
// services' "dependencies" docs look alike). `reject` = keep them separate; `reason`
// explains either way. title/summary/body are the consolidation to write when applied.
export interface ConsolidationResult {
  recommendation: ConsolidationRecommendation;
  reason: string;
  title: string;
  summary: string;
  body: string;
}

export interface ReconcileResult {
  action: ReconcileAction;
  target_id: string | null; // the existing record the action applies to (null for noop)
  reason: string;
}

// A write-time duplicate judgment. When a new semantic write resembles existing
// records, the provider decides whether the draft is genuinely new (`noop`), refines
// ONE existing record (`update` -> the agent should revise that node), or replaces one
// (`supersede` -> invalidate + supersedes). The provider only judges; the write tool
// surfaces the verdict and never auto-applies it.
export interface ReconcileTask {
  draft: ReconcileTaskDraft;
  project: string | null;
  candidates: ReconcileCandidate[];
}

export interface ReconcileTaskDraft {
  title: string;
  type: string;
  content: string;
}

export interface ReconcileCandidate {
  id: string;
  title: string;
  content: string;
}

// Attribute mining for one semantic record. The provider reads the
// record and proposes retrieval attributes — keywords/synonyms a future query might use,
// short topical tags, and a one-sentence context — which the daemon folds into the FTS
// text for wider recall. Faithful: surface what the record is about, invent no facts.
export interface AnnotateTask {
  title: string;
  content: string;
  project: string | null;
}

export interface AnnotateResult {
  keywords: string[];
  tags: string[];
  context: string;
}

export enum ConsolidationRecommendation {
  APPLY = "apply",
  REJECT = "reject",
}

export enum ReconcileAction {
  NOOP = "noop",
  UPDATE = "update",
  SUPERSEDE = "supersede",
}
