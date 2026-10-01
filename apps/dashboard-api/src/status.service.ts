import { Inject, Injectable } from "@nestjs/common";
import type {
  DaemonHealth,
  DashboardJob,
  DashboardProcess,
  DashboardStatus,
  GenerationStatus,
  OllamaHealth,
} from "@cerebrium/contracts/dashboard";
import type { TechStats } from "@cerebrium/contracts/types";
import { KernelClient } from "./kernel.client";

export const OLLAMA_URL = Symbol("OllamaUrl");

interface OperatorView extends TechStats {
  processes?: (DashboardProcess & Record<string, unknown>)[];
  generation?: { provider: string; enabled: boolean; roles?: Record<string, { model?: string }> };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function modelState(model: unknown): string | null {
  if (model == null) return null;
  if (typeof model === "string") return model;

  const state = (model as { state?: unknown }).state;

  return typeof state === "string" ? state : JSON.stringify(model);
}

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

@Injectable()
export class StatusService {
  constructor(
    @Inject(KernelClient) private readonly kernel: KernelClient,
    @Inject(OLLAMA_URL) private readonly ollamaUrl: string,
  ) {}

  async status(): Promise<DashboardStatus> {
    const [health, operator, jobs, reviews, ollama] = await Promise.allSettled([
      this.kernel.call<Record<string, unknown>>("health", {}, 5_000),
      this.kernel.call<OperatorView>("operator_snapshot"),
      this.kernel.call<{ jobs: DashboardJob[] }>("job_status", { limit: 15 }),
      this.kernel.call<{ pending: { edges: number; nodes: number } }>("list_reviews", {
        limit: 1,
      }),
      this.ollama(),
    ]);
    const view = settled(operator);

    return {
      generated_at: new Date().toISOString(),
      kernel_connected: health.status === "fulfilled",
      daemon: this.daemon(health),
      ollama: settled(ollama) ?? {
        ok: false,
        error: "probe failed",
        url: this.ollamaUrl,
        models: [],
      },
      generation: view ? this.generation(view) : null,
      stats: view ? this.stats(view) : null,
      processes: (view?.processes ?? []).map((p) => ({
        role: p.role,
        pid: p.pid,
        alive: p.alive,
        started_at: p.started_at,
        model_state: p.model_state ?? null,
        model_error: p.model_error ?? null,
      })),
      jobs: (settled(jobs)?.jobs ?? []).map((j) => ({
        id: j.id,
        kind: j.kind,
        state: j.state,
        attempts: j.attempts,
        max_attempts: j.max_attempts,
        created_at: j.created_at,
        started_at: j.started_at,
        ended_at: j.ended_at,
        last_error: j.last_error,
      })),
      review_pending: (() => {
        const r = settled(reviews);

        return r ? r.pending.edges + r.pending.nodes : null;
      })(),
    };
  }

  private daemon(health: PromiseSettledResult<Record<string, unknown>>): DaemonHealth {
    if (health.status === "rejected") {
      return { ok: false, error: message(health.reason), protocol: null, pid: null, model: null };
    }

    const h = health.value;
    const model = h.model;

    return {
      ok: true,
      error: null,
      protocol: typeof h.protocol === "number" ? h.protocol : null,
      pid: typeof h.pid === "number" ? h.pid : null,
      model: modelState(model),
    };
  }

  private generation(view: OperatorView): GenerationStatus | null {
    if (!view.generation) return null;

    return {
      provider: view.generation.provider,
      enabled: view.generation.enabled,
      model: view.generation.roles?.generate?.model ?? null,
    };
  }

  // The full operator view carries the whole config; the browser gets only the stats.
  private stats(view: OperatorView): TechStats {
    const {
      processes: _p,
      generation: _g,
      ...rest
    } = view as OperatorView & {
      config?: unknown;
    };
    const { config: _c, ...stats } = rest as TechStats & { config?: unknown };

    return stats;
  }

  private async ollama(): Promise<OllamaHealth> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json()) as { models?: { name: string }[] };

      return {
        ok: res.ok,
        error: res.ok ? null : `HTTP ${String(res.status)}`,
        url: this.ollamaUrl,
        models: (body.models ?? []).map((m) => m.name),
      };
    } catch (err) {
      return { ok: false, error: message(err), url: this.ollamaUrl, models: [] };
    }
  }
}
