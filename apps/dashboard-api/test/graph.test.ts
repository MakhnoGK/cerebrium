import { describe, expect, it } from "vitest";
import { ApiController } from "@dashboard-api/api.controller";
import type { KernelClient } from "@dashboard-api/kernel.client";
import type { StatusService } from "@dashboard-api/status.service";

describe("Dashboard graph", () => {
  it("should ask the kernel for the snapshot with only the extras switched on", async () => {
    // Given
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const kernel = {
      call: (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });

        return Promise.resolve({ generated_at: "t", nodes: [], edges: [] });
      },
    } as unknown as KernelClient;
    const api = new ApiController(kernel, {} as StatusService);

    // When
    await api.graph();
    await api.graph("1", "0");

    // Then
    expect(calls).toEqual([
      { name: "graph_snapshot", args: { invalidated: false, symbols: false } },
      { name: "graph_snapshot", args: { invalidated: true, symbols: false } },
    ]);
  });
});
