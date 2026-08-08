import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { VECTOR_DIM, type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { ConsolidationWorker } from "@/application/workers";
import { ConsolidationKind, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { ConsolidationThresholdsConfig, RetrievalConfig } from "@/infrastructure/config";
import { setup, TestEnv } from "@test/helpers";

// The gates live a few thousandths apart, which the hashed null provider cannot hit on
// purpose. This one places every text on a circle in the first two dimensions, so the
// cosine between two fixtures is exactly cos(θa - θb) and a test can sit either side of a
// threshold deliberately. A fixture is recognised by a marker token its text contains.
function angleProvider(angles: Record<string, number>): EmbeddingProvider {
  return {
    name: "angle",
    version: "1",
    dim: VECTOR_DIM,
    embed(texts: string[]): Promise<number[][]> {
      return Promise.resolve(
        texts.map((text) => {
          const marker = Object.keys(angles).find((m) => text.toLowerCase().includes(m));
          const theta = marker === undefined ? Math.PI / 2 : (angles[marker] ?? 0);
          const v = new Array<number>(VECTOR_DIM).fill(0);

          v[0] = Math.cos(theta);
          v[1] = Math.sin(theta);

          return v;
        }),
      );
    },
  };
}

// Two texts whose embeddings sit exactly `cos` apart.
function pairAt(cos: number): EmbeddingProvider {
  return angleProvider({ alpha: 0, beta: Math.acos(cos) });
}

const P = "billing";

type WriteResult = Awaited<ReturnType<WriteTool["invoke"]>>;

function write(title: string, content: string): Promise<WriteResult> {
  return container
    .resolve(SessionStartTool)
    .invoke({ project: P })
    .then(({ session_id }) =>
      container.resolve(WriteTool).invoke({
        session_id,
        parent_node_id: null,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title,
        content,
        project: P,
      }),
    );
}

// Seeds `alpha`, embeds it, then writes `beta` — so beta's probe sees an embedded alpha.
async function probeAgainstSeed(env: TestEnv) {
  const seed = await write("Alpha fact", "the alpha invariant holds for every settled invoice");
  await env.worker.tick();
  const probe = await write("Beta fact", "the beta invariant holds for every settled invoice");

  return { seed, probe };
}

describe("Dedup probe gate", () => {
  it("should stay silent when a candidate falls below the dedup threshold", async () => {
    // Given
    const env = setup({ provider: pairAt(0.9) });

    // When
    const { probe } = await probeAgainstSeed(env);

    // Then
    expect(probe.similar_existing).toBeUndefined();
  });

  it("should surface a candidate as moderate when it clears dedup but not merge", async () => {
    // Given
    const env = setup({ provider: pairAt(0.921) });

    // When
    const { seed, probe } = await probeAgainstSeed(env);

    // Then
    expect(probe.similar_existing?.[0]?.id).toBe(seed.id);
    expect(probe.similar_existing![0]!.confidence).toBe("moderate");
  });

  it("should surface a candidate as high when it also clears the merge threshold", async () => {
    // Given
    const env = setup({ provider: pairAt(0.93) });

    // When
    const { seed, probe } = await probeAgainstSeed(env);

    // Then
    expect(probe.similar_existing?.[0]?.id).toBe(seed.id);
    expect(probe.similar_existing![0]!.confidence).toBe("high");
  });

  it("should report the score at three decimals so the decision band is not quantised away", async () => {
    // Given
    const env = setup({ provider: pairAt(0.9213) });

    // When
    const { probe } = await probeAgainstSeed(env);

    // Then
    expect(probe.similar_existing![0]!.score).toBe(0.921);
  });
});

describe("Merge gate boundary", () => {
  it("should not propose a merge when the pair sits just below mergeSim", async () => {
    // Given
    const env = setup({ provider: pairAt(0.924) });
    await probeAgainstSeed(env);
    await env.worker.tick();

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_suggested).toBe(0);
    expect(env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE })).toHaveLength(0);
  });

  it("should propose a merge when the pair sits just above mergeSim", async () => {
    // Given
    const env = setup({ provider: pairAt(0.926) });
    await probeAgainstSeed(env);
    await env.worker.tick();

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_suggested).toBe(1);
  });
});

describe("Lexical dedup fallback", () => {
  it("should catch a partial overlap that the cosine gate would have rejected", async () => {
    // Given / When — nothing drained, so the probe has no vectors and falls back to Jaccard
    setup();
    const seed = await write("Refund window", "a refund can be issued within thirty days");
    const probe = await write("Refund window", "a refund can be issued within thirty days or so");

    // Then
    expect(probe.similar_existing?.[0]?.id).toBe(seed.id);

    const score = probe.similar_existing![0]!.score;

    expect(score).toBeGreaterThanOrEqual(container.resolve(RetrievalConfig).lexicalDedupThreshold);
    expect(score).toBeLessThan(container.resolve(RetrievalConfig).dedupThreshold);
  });

  it("should stay silent when the lexical overlap is below its own threshold", async () => {
    // Given / When
    setup();
    await write("Refund window", "a refund can be issued within thirty days");
    const probe = await write("Deploy cadence", "we ship the mobile app every second thursday");

    // Then
    expect(probe.similar_existing).toBeUndefined();
  });
});

describe("Calibrated threshold defaults", () => {
  it("should keep merge strictly stricter than the write-time dedup probe", () => {
    // Given
    setup();

    // When
    const retrieval = container.resolve(RetrievalConfig);
    const thresholds = container.resolve(ConsolidationThresholdsConfig);

    // Then
    expect(thresholds.mergeSim).toBeGreaterThan(retrieval.dedupThreshold);
    expect(retrieval.dedupThreshold).toBeGreaterThan(thresholds.sim);
  });
});
