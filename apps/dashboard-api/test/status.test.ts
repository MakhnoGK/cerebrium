import { describe, expect, it } from "vitest";
import type { KernelClient } from "@dashboard-api/kernel.client";
import { StatusService } from "@dashboard-api/status.service";

function kernel(answers: Record<string, unknown>): KernelClient {
  return {
    call: (name: string) =>
      name in answers
        ? answers[name] instanceof Error
          ? Promise.reject(answers[name])
          : Promise.resolve(answers[name])
        : Promise.reject(new Error(`unexpected ${name}`)),
  } as unknown as KernelClient;
}

const OPERATOR = {
  queue: { backlog: 0 },
  processes: [
    {
      role: "daemon",
      pid: 7,
      alive: true,
      started_at: "2026-10-01T00:00:00.000Z",
      config_state: "absent",
      model_state: "ready",
      model_error: null,
    },
  ],
  generation: { provider: "http@1", enabled: true, roles: { generate: { model: "gemma" } } },
  config: { values: { secret: "never sent" } },
};

describe("Dashboard status", () => {
  it("should report the daemon, generation and review backlog, and never the config", async () => {
    // Given
    const service = new StatusService(
      kernel({
        health: { protocol: 2, pid: 7, model: { state: "ready", ms: 600 } },
        operator_snapshot: OPERATOR,
        job_status: { jobs: [] },
        list_reviews: { pending: { edges: 2, nodes: 1 } },
      }),
      "http://127.0.0.1:1",
    );

    // When
    const status = await service.status();

    // Then
    expect(status).toMatchObject({
      kernel_connected: true,
      daemon: { ok: true, pid: 7, model: "ready" },
      generation: { provider: "http@1", enabled: true, model: "gemma" },
      processes: [{ role: "daemon", alive: true, model_state: "ready" }],
      review_pending: 3,
      ollama: { ok: false },
    });
    expect(JSON.stringify(status)).not.toContain("never sent");
  });

  it("should say the kernel is unreachable rather than fail", async () => {
    // Given
    const service = new StatusService(kernel({ health: new Error("connect ENOENT") }), "x");

    // When
    const status = await service.status();

    // Then
    expect(status).toMatchObject({
      kernel_connected: false,
      daemon: { ok: false, error: "connect ENOENT" },
      stats: null,
      processes: [],
    });
  });
});
