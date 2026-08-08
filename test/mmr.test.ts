import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { VECTOR_DIM, type EmbeddingProvider } from "@/domain/ports/embedding-provider";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { RetrievalConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

// Fixtures sit on a circle in the first two dimensions, so the cosine between any two
// of them is exactly cos(theta_a - theta_b) and a test can place a pair at a chosen
// similarity on purpose. Texts with no marker land at PI/2.
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

function lambdaOf(value: string): RetrievalConfig {
  return new RetrievalConfig(new StaticConfigSource({ MEMORY_MMR_LAMBDA: value }));
}

const SHARED = "retrieval";
const QUERY = `${SHARED} alpha`;

async function write(s: string, title: string, marker: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `${SHARED} notes about ${marker}`,
  });
}

// Two twins on the same angle (cosine 1.0) plus one orthogonal node, all three matching
// the query by text so every candidate reaches the cut.
async function twinsAndOutlier(env: TestEnv) {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const twin = await write(s, "Alpha one", "alpha");
  const nearDuplicate = await write(s, "Alpha two", "alpha");
  const outlier = await write(s, "Beta", "beta");

  await env.worker.tick();

  return { s, twin: twin.id, nearDuplicate: nearDuplicate.id, outlier: outlier.id };
}

function ids(res: unknown): string[] {
  return (res as { results: Envelope[] }).results.map((r) => r.id);
}

function search(session_id: string, limit: number) {
  return container.resolve(SearchTool).invoke({ session_id, query: QUERY, limit });
}

afterEach(() => {
  container.register(RetrievalConfig, {
    useValue: new RetrievalConfig(new StaticConfigSource({})),
  });
});

describe("MMR diversity at the cut", () => {
  const provider = () => angleProvider({ alpha: 0, beta: Math.PI / 2 });

  it("should return the distinct hit instead of the near-duplicate when lambda favours diversity", async () => {
    // Given
    const env = setup({ provider: provider() });
    container.register(RetrievalConfig, { useValue: lambdaOf("0.3") });
    const { s, twin, nearDuplicate, outlier } = await twinsAndOutlier(env);

    // When
    const top = ids(await search(s, 2));

    // Then
    expect(top).toContain(twin);
    expect(top).toContain(outlier);
    expect(top).not.toContain(nearDuplicate);
  });

  it("should keep the near-duplicate when lambda is 1", async () => {
    // Given
    const env = setup({ provider: provider() });
    container.register(RetrievalConfig, { useValue: lambdaOf("1") });
    const { s, twin, nearDuplicate, outlier } = await twinsAndOutlier(env);

    // When
    const top = ids(await search(s, 2));

    // Then
    expect(top).toEqual(expect.arrayContaining([twin, nearDuplicate]));
    expect(top).not.toContain(outlier);
  });

  it("should keep the most relevant hit first when diversity is on", async () => {
    // Given
    const env = setup({ provider: provider() });
    container.register(RetrievalConfig, { useValue: lambdaOf("0.3") });
    const { s } = await twinsAndOutlier(env);
    const relevanceOrder = ids(await search(s, 10));

    // When
    container.register(RetrievalConfig, { useValue: lambdaOf("0.3") });
    const diverse = ids(await search(s, 2));

    // Then
    expect(diverse[0]).toBe(relevanceOrder[0]);
  });

  it("should return the same order when an identical search is repeated", async () => {
    // Given
    const env = setup({ provider: provider() });
    container.register(RetrievalConfig, { useValue: lambdaOf("0.3") });
    const { s } = await twinsAndOutlier(env);

    // When
    const first = ids(await search(s, 3));
    const second = ids(await search(s, 3));

    // Then
    expect(second).toEqual(first);
  });
});

describe("MMR with missing vectors", () => {
  it("should still return a candidate that has no stored vector", async () => {
    // Given
    const env = setup({ provider: angleProvider({ alpha: 0, beta: Math.PI / 2 }) });
    container.register(RetrievalConfig, { useValue: lambdaOf("0.3") });
    const { s } = await twinsAndOutlier(env);
    // Written after the drain, so it is FTS-findable and vector-invisible.
    const pending = await write(s, "Alpha three", "alpha");

    // When
    const top = ids(await search(s, 3));

    // Then
    expect(top).toContain(pending.id);
  });

  it("should fall back to relevance order when nothing is embedded", async () => {
    // Given
    setup({ provider: angleProvider({ alpha: 0, beta: Math.PI / 2 }) });
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await write(s, "Alpha one", "alpha");
    await write(s, "Alpha two", "alpha");
    await write(s, "Beta", "beta");

    // When
    container.register(RetrievalConfig, { useValue: lambdaOf("1") });
    const relevanceOrder = ids(await search(s, 2));
    container.register(RetrievalConfig, { useValue: lambdaOf("0.3") });
    const diverse = ids(await search(s, 2));

    // Then
    expect(diverse).toEqual(relevanceOrder);
  });
});
