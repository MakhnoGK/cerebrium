import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import {
  isControlRead,
  isReadName,
  READ_SURFACE,
  SEARCH_MEMORY,
  type ReadName,
  type SearchMemory,
} from "@/application/use-cases";
import { LocalNullProvider } from "@/embeddings/local-null";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

// Counts embed calls so a test can prove the model was never asked.
class CountingProvider implements EmbeddingProvider {
  readonly name = "counting";
  readonly version = "1";
  readonly dim: number;
  calls = 0;

  constructor(private readonly inner = new LocalNullProvider()) {
    this.dim = inner.dim;
  }

  embed(texts: string[]): Promise<number[][]> {
    this.calls++;

    return this.inner.embed(texts);
  }
}

let env: TestEnv;
let session: string;

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Read surface naming", () => {
  it("should name every read a worker or socket may dispatch", () => {
    // Given / When / Then
    expect(Object.keys(READ_SURFACE).sort()).toEqual([
      "fetch_nodes",
      "lookup_code",
      "operator_snapshot",
      "search_memory",
      "stats_snapshot",
    ]);
  });

  it("should recognise its own names and reject anything else", () => {
    // Given / When / Then
    expect(isReadName("search_memory")).toBe(true);
    expect(isReadName("write_memory")).toBe(false);
    expect(isReadName("__proto__")).toBe(false);
  });

  it("should classify the status reads as control, so they never queue behind a search", () => {
    // Given / When / Then
    expect(isControlRead("stats_snapshot")).toBe(true);
    expect(isControlRead("operator_snapshot")).toBe(true);
    expect(isControlRead("search_memory")).toBe(false);
  });

  it("should expose no writing use case", () => {
    // Given — the pool hands these to a read-only database handle, so a writer here
    // would fail at runtime rather than at review time.
    const names = Object.keys(READ_SURFACE) as ReadName[];

    // When / Then
    for (const name of names) {
      expect(name).not.toMatch(/write|update|invalidate|restore|link|checkpoint|apply|upsert/);
    }
  });
});

describe("Precomputed query vector", () => {
  it("should skip the provider entirely when the caller supplies the vector", async () => {
    // Given
    const topic = "the http client retries three times with exponential backoff";
    await container.resolve(WriteTool).invoke({
      session_id: session,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Retry budget",
      content: topic,
    });
    await env.worker.tick();

    const counting = new CountingProvider();
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: counting });
    const [vector] = await new LocalNullProvider().embed(["http client retries"]);
    counting.calls = 0;

    // When
    const withVector = await container.resolve<SearchMemory>(SEARCH_MEMORY).invoke({
      query: "http client retries",
      limit: 5,
      query_vector: vector,
    });

    // Then
    expect(counting.calls).toBe(0);
    expect(withVector.results.length).toBeGreaterThan(0);
  });

  it("should embed the query itself when no vector is supplied", async () => {
    // Given
    const counting = new CountingProvider();
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: counting });

    // When
    await container
      .resolve<SearchMemory>(SEARCH_MEMORY)
      .invoke({ query: "http client retries", limit: 5 });

    // Then
    expect(counting.calls).toBeGreaterThan(0);
  });

  it("should reach the same results with a supplied vector as without one", async () => {
    // Given
    const topic = "deployment rollback procedure for the api gateway";
    await container.resolve(WriteTool).invoke({
      session_id: session,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Rollback",
      content: topic,
    });
    await env.worker.tick();

    const search = container.resolve<SearchMemory>(SEARCH_MEMORY);
    const query = "deployment rollback";
    const [vector] = await new LocalNullProvider().embed([query]);

    // When
    const organic = await search.invoke({ query, limit: 5 });
    const supplied = await search.invoke({ query, limit: 5, query_vector: vector });

    // Then
    expect(supplied.results.map((r) => r.id)).toEqual(organic.results.map((r) => r.id));
  });
});
