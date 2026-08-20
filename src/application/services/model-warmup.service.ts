import { inject, injectable } from "tsyringe";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";

export interface WarmupOutcome {
  state: "ready" | "failed";
  ms: number;
  error?: string;
}

// Loading a local embedding model costs ~600ms wall clock and blocks the event loop for
// ~111ms of it (measured 2026-08-20). Inference itself does not — onnxruntime-node runs
// the graph on its own threads — so the load is the one part worth moving off the path of
// a request that happens to be first.
@injectable()
export class ModelWarmupService {
  constructor(
    @inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async warm(): Promise<WarmupOutcome> {
    const started = Date.parse(this.clock.now());

    try {
      await this.provider.warm?.();

      return { state: "ready", ms: this.since(started) };
    } catch (err) {
      // Fail open. A model that cannot load makes every drain tick fail and back off,
      // which the queue already handles; refusing to start would be worse, and would
      // hide the reason.
      return {
        state: "failed",
        ms: this.since(started),
        error: (err as Error).message || String(err),
      };
    }
  }

  private since(startedMs: number): number {
    return Math.max(0, Date.parse(this.clock.now()) - startedMs);
  }
}
