import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { RetrievalConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup } from "@test/helpers";

type Result = Envelope & { matched: string };

let session: string;

function ceilingOf(value: string): void {
  container.register(RetrievalConfig, {
    useValue: new RetrievalConfig(new StaticConfigSource({ MEMORY_GRAPH_BASE: value })),
  });
}

function write(title: string, content: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
  });
}

// Nothing is embedded, so the only direct hits are the ones matching lexically and anything
// else in the results arrived by diffusion. The two direct hits sit at adjacent RRF ranks;
// the neighbour hangs off the stronger one and can only be reached through the edge.
async function chain() {
  const strong = await write("Retry budget", "the http client retries with exponential backoff");
  const weak = await write("Backoff notes", "exponential backoff, briefly");
  const neighbour = await write("Gateway config", "the api gateway routes tenant traffic");

  await container
    .resolve(LinkTool)
    .invoke({ session_id: session, src: strong.id, dst: neighbour.id, type: EdgeType.REFERENCES });

  return { strong: strong.id, weak: weak.id, neighbour: neighbour.id };
}

async function search(): Promise<Result[]> {
  const res = await container.resolve(SearchTool).invoke({
    session_id: session,
    query: "exponential backoff retries",
    limit: 10,
  });

  return res.results as Result[];
}

beforeEach(async () => {
  setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

afterEach(() => {
  container.register(RetrievalConfig, {
    useValue: new RetrievalConfig(new StaticConfigSource({})),
  });
});

describe("MEMORY_GRAPH_BASE", () => {
  it("should default to 0.3", () => {
    // Given / When
    const config = new RetrievalConfig(new StaticConfigSource({}));

    // Then
    expect(config.graphBase).toBe(0.3);
  });

  it("should rank a graph hit below every direct hit at the default ceiling", async () => {
    // Given
    const { neighbour } = await chain();

    // When
    const results = await search();

    // Then
    expect(results.at(-1)!.id).toBe(neighbour);
    expect(results.at(-1)!.matched).toBe("graph");
  });

  it("should lift a graph hit over a weaker direct hit when the ceiling is raised", async () => {
    // Given
    const { strong, weak, neighbour } = await chain();
    ceilingOf("1");

    // When
    const ids = (await search()).map((r) => r.id);

    // Then
    expect(ids.indexOf(neighbour)).toBeLessThan(ids.indexOf(weak));
    expect(ids[0]).toBe(strong);
  });

  it("should still surface the neighbour when the ceiling is zero", async () => {
    // Given
    const { neighbour } = await chain();
    ceilingOf("0");

    // When
    const results = await search();

    // Then
    expect(results.map((r) => r.id)).toContain(neighbour);
  });
});
