import {
  type AnnotateResult,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ReconcileResult,
} from "@/domain/ports/consolidation-provider";
import { CommandConsolidator } from "@/consolidation/command";
import { HttpConsolidator } from "@/consolidation/http";
import { ManualConsolidator } from "@/consolidation/manual";

// `off` disables consolidation entirely — the daemon's ConsolidationWorker checks the
// provider (and per-behavior posture) and skips detection. Distinct from `manual`, which
// still detects and queues candidates but never generates. `generate`/`reconcile` are
// never called.
class DisabledConsolidator implements ConsolidationProvider {
  readonly name = "off";
  readonly version = "1";
  readonly enabled = false;

  generate(): Promise<ConsolidationResult> {
    return Promise.reject(new Error("consolidation is off"));
  }

  reconcile(): Promise<ReconcileResult> {
    return Promise.reject(new Error("consolidation is off"));
  }

  annotate(): Promise<AnnotateResult> {
    return Promise.reject(new Error("consolidation is off"));
  }
}

// Generation provider chosen by env at startup. Default `manual` keeps the suite offline
// (no network, no keys) and routes clusters to the candidate queue for an agent. `http`
// targets a local Ollama; `command` pipes to any user process. Adding a backend is a
// one-file change plus a class — the ConsolidationProvider interface is the contract.
export function createConsolidator(
  name = process.env.MEMORY_CONSOLIDATE ?? "manual",
): ConsolidationProvider {
  if (name === "off") return new DisabledConsolidator();
  if (name === "http") return new HttpConsolidator();
  if (name === "command") return new CommandConsolidator();

  return new ManualConsolidator();
}
