import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { createHandler } from "@/read-worker";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let session: string;

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Read worker dispatch", () => {
  it("should resolve a named read and return its result", async () => {
    // Given
    await container.resolve(WriteTool).invoke({
      session_id: session,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Retry budget",
      content: "the http client retries with exponential backoff",
    });
    await env.worker.tick();
    const handle = createHandler(container);

    // When
    const result = (await handle({
      id: 1,
      name: "search_memory",
      args: { query: "http client retries", limit: 5 },
    })) as { results: unknown[] };

    // Then
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("should refuse a name that is not on the read surface", async () => {
    // Given
    const handle = createHandler(container);

    // When / Then — a write must not be reachable through the pool even by name.
    await expect(handle({ id: 1, name: "write_memory", args: {} })).rejects.toThrow(
      /not a read use case: write_memory/,
    );
  });

  it("should refuse a prototype key masquerading as a read name", async () => {
    // Given
    const handle = createHandler(container);

    // When / Then
    await expect(handle({ id: 1, name: "constructor", args: {} })).rejects.toThrow(
      /not a read use case/,
    );
  });

  it("should propagate a thrown failure rather than hanging", async () => {
    // Given — the pool turns a rejection into an error response; a swallowed throw would
    // leave the caller waiting forever instead.
    const handle = createHandler(container);

    // When / Then
    await expect(handle({ id: 1, name: "search_memory", args: null })).rejects.toThrow();
  });
});
