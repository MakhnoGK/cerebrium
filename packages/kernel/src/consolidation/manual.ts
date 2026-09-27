import {
  type AnnotateResult,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ReconcileResult,
} from "@/domain/ports/consolidation-provider";

// The default, offline, test-safe provider: no autonomous generation. `enabled` is
// false, so the daemon routes detected clusters to the candidate queue for an agent to
// author via consolidate_apply, and the write tool keeps its advisory dedup hint.
// `generate`/`reconcile` are never called; they throw to make a misconfiguration (auto
// posture without a real provider) fail loudly rather than silently.
export class ManualConsolidator implements ConsolidationProvider {
  readonly name = "manual";
  readonly version = "1";
  readonly enabled = false;

  generate(): Promise<ConsolidationResult> {
    return Promise.reject(
      new Error("manual consolidation provider does not generate — an agent authors the summary"),
    );
  }

  reconcile(): Promise<ReconcileResult> {
    return Promise.reject(
      new Error("manual consolidation provider does not judge duplicates — an agent decides"),
    );
  }

  annotate(): Promise<AnnotateResult> {
    return Promise.reject(
      new Error("manual consolidation provider does not annotate — no generation backend"),
    );
  }
}
