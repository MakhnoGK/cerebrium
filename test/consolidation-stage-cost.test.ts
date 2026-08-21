import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSOLIDATION_REPORTER_TOKEN } from "@/domain/ports/consolidation-reporter";
import { ConsolidationWorker } from "@/application/workers";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { ConsolidationBatchConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

// The neighbour pass is a run of synchronous vector searches on the thread that serves the
// socket, and one row per run keeps only the last stage name — so both what a sweep costs
// and whether it lets go of the loop are invisible without these.

let env: TestEnv;

async function seedNodes(count: number): Promise<void> {
  const write = container.resolve(WriteTool);
  const { session_id } = await container.resolve(SessionStartTool).invoke({});

  for (let i = 0; i < count; i++) {
    await write.invoke({
      session_id,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: `Fact ${String(i)}`,
      content: `the deploy pipeline retries on failure, variant ${String(i)}, with enough words to chunk`,
    });
  }

  await env.worker.tick();
}

beforeEach(() => {
  env = setup();
});

// The override below lands in the global container, so it has to be put back.
afterEach(() => {
  container.register(ConsolidationBatchConfig, {
    useValue: new ConsolidationBatchConfig(new StaticConfigSource({})),
  });
});

describe("Sweep cost", () => {
  it("should record how long each stage of a sweep took", async () => {
    // Given / When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(Object.keys(result.stage_ms ?? {})).toEqual(
      expect.arrayContaining(["neighbours", "links", "distill", "merge", "mirrors", "backfill"]),
    );

    const stored = env.db.prepare("SELECT stage_ms FROM consolidation_runs").get() as {
      stage_ms: string | null;
    };

    expect(JSON.parse(stored.stage_ms ?? "{}")).toMatchObject({ neighbours: expect.any(Number) });
  });

  it("should hand the event loop back while walking the seed set", async () => {
    // Given — more seeds than one breath's worth, and a counter of how many turns the loop
    // takes between the pass starting and the next stage being reported.
    await seedNodes(30);

    container.register(ConsolidationBatchConfig, {
      useValue: new ConsolidationBatchConfig(
        new StaticConfigSource({ MEMORY_CONSOLIDATE_ITEMS_PER_BREATH: "4" }),
      ),
    });

    let turns = 0;
    let spinning = true;
    const spin = () => {
      if (!spinning) return;
      turns++;
      setImmediate(spin);
    };
    const at: Record<string, number> = {};

    container.register(CONSOLIDATION_REPORTER_TOKEN, {
      useValue: {
        reportTick: (_runId: string, result: { stage?: string }) => {
          at[result.stage ?? "?"] = turns;
        },
      },
    });

    // When
    setImmediate(spin);
    await container.resolve(ConsolidationWorker).tick();
    spinning = false;

    // Then
    expect((at.links ?? 0) - (at.neighbours ?? 0)).toBeGreaterThan(0);
    expect((at.citations ?? 0) - (at.links ?? 0)).toBeGreaterThan(0);
  });
});
