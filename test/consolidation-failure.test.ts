import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsolidationProvider } from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
import { ConsolidationKind, ConsolidationStatus, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const TIMED_OUT = "consolidation http provider: timed out after 500000ms";

function failing(opts: { generate?: string; annotate?: string }): ConsolidationProvider {
  return {
    name: "failing-stub",
    version: "1",
    enabled: true,
    generate: () =>
      opts.generate
        ? Promise.reject(new Error(opts.generate))
        : Promise.reject(new Error("not used")),
    reconcile: () => Promise.reject(new Error("not used")),
    annotate: () =>
      opts.annotate
        ? Promise.reject(new Error(opts.annotate))
        : Promise.resolve({ keywords: [], tags: [], context: "" }),
  };
}

async function queueOne(env: TestEnv): Promise<string> {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const members: string[] = [];

  for (const suffix of ["a", "b"]) {
    const node = (await container.resolve(WriteTool).invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: `payments ${suffix}`,
      content: `payments authorize capture ${suffix}`,
    })) as Envelope;

    members.push(node.id);
  }

  return env.consolidation.insertCandidate({
    kind: ConsolidationKind.MERGE,
    member_ids: members,
    canonical_id: members[0]!,
    score: 0.95,
    detected_at: "2026-01-01T00:00:00.000Z",
  })!;
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_ANNOTATE;
});

describe("Generation failure reporting", () => {
  it("should count the failure and keep its reason when generation throws", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const env = setup({ consolidator: failing({ generate: TIMED_OUT }) });
    const id = await queueOne(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.generation_failures).toBe(1);
    expect(r.last_error).toBe(TIMED_OUT);

    // Degradation is unchanged: the candidate survives, bare, for the next sweep.
    const cand = env.consolidation.getCandidate(id)!;
    expect(cand.proposal).toBeNull();
    expect(cand.status).toBe(ConsolidationStatus.PENDING);
    expect(r.proposals_backfilled).toBe(0);
  });

  it("should count an annotation failure with its reason", async () => {
    // Given
    const env = setup({ consolidator: failing({ annotate: "annotate exploded" }) });
    await queueOne(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.generation_failures).toBeGreaterThan(0);
    expect(r.last_error).toBe("annotate exploded");
    expect(r.annotated).toBe(0);
  });

  it("should report no failure when the provider is the manual/disabled default", async () => {
    // Given — manual detects and queues but never generates; that is posture, not breakage.
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const env = setup();
    await queueOne(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.generation_failures).toBe(0);
    expect(r.last_error).toBeNull();
  });

  it("should bound the stored reason so a provider cannot flood the tick result", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_ANNOTATE = "off";
    const env = setup({ consolidator: failing({ generate: "x".repeat(5_000) }) });
    await queueOne(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.last_error).toHaveLength(500);
  });
});
