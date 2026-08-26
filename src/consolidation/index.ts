import {
  type AnnotateResult,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ReconcileResult,
} from "@/domain/ports/consolidation-provider";
import { CommandConsolidator } from "@/consolidation/command";
import { HttpConsolidator } from "@/consolidation/http";
import { ManualConsolidator } from "@/consolidation/manual";
import type { ResolvedRoles } from "@/consolidation/roles";

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

// What a backend needs to be built. `roles` carries the resolved per-role model, host and
// deadline; the flat fields are what a directly-constructed adapter (tests, scripts) falls
// back to, and are what `roles` is resolved FROM in production.
export interface BackendOptions {
  roles?: ResolvedRoles;
  url?: string;
  model?: string;
  cmd?: string;
  timeoutMs?: number;
  reconcileTimeoutMs?: number;
}

// The backends, by the name `consolidation.provider` selects. Default `manual` keeps the
// suite offline (no network, no keys) and routes clusters to the candidate queue for an
// agent. `http` targets a local Ollama; `command` pipes to any user process. Adding one is
// an entry here plus a class — the ConsolidationProvider interface is the contract.
//
// Selection is per deployment, not per role: `enabled` is a property of the backend (a
// `manual` provider generates nothing at all), and the per-behaviour switch is
// `consolidation.posture.*`. A role chooses its model, never its backend.
const BACKENDS: Record<string, (opts: BackendOptions) => ConsolidationProvider> = {
  off: () => new DisabledConsolidator(),
  manual: () => new ManualConsolidator(),
  http: (opts) => new HttpConsolidator(opts),
  command: (opts) => new CommandConsolidator(opts),
};

export const BACKEND_NAMES: readonly string[] = Object.keys(BACKENDS);

// An unknown name falls back to `manual` rather than throwing: a typo must leave the store
// working with no autonomous generation, not refuse to start.
export function createConsolidator(
  name = "manual",
  opts: BackendOptions = {},
): ConsolidationProvider {
  return (BACKENDS[name] ?? BACKENDS.manual!)(opts);
}
