import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

type Result = Envelope & { matched: string; via?: { node: string; edge: string } };

let session: string;

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

function link(src: string, dst: string, type: EdgeType): Promise<unknown> {
  return container.resolve(LinkTool).invoke({ session_id: session, src, dst, type });
}

async function search(query: string, args: { expand_graph?: boolean } = {}): Promise<Result[]> {
  const res = await container
    .resolve(SearchTool)
    .invoke({ session_id: session, query, limit: 10, ...args });

  return res.results as Result[];
}

beforeEach(async () => {
  setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("PPR graph expansion", () => {
  // Nothing is embedded on purpose: with no vector branch the only direct hit is the one
  // the query matches lexically, so anything else in the results arrived by diffusion.
  // reference sits one hop from the anchor, distant two.
  async function chain() {
    const anchor = await write("Retry budget", "the http client retries with exponential backoff");
    const reference = await write("Gateway config", "the api gateway routes tenant traffic");
    const distant = await write("Tenant onboarding", "how a tenant is provisioned at signup");

    await link(anchor.id, reference.id, EdgeType.REFERENCES);
    await link(reference.id, distant.id, EdgeType.REFERENCES);

    return { anchor: anchor.id, reference: reference.id, distant: distant.id };
  }

  it("should surface a node two hops from the only matched node", async () => {
    // Given
    const { anchor, distant } = await chain();

    // When
    const results = await search("exponential backoff retries");

    // Then
    expect(results[0]!.id).toBe(anchor);
    const hit = results.find((r) => r.id === distant);
    expect(hit).toBeDefined();
    expect(hit!.matched).toBe("graph");
  });

  it("should report the strongest contributor as via when a node surfaces", async () => {
    // Given
    const { anchor, reference } = await chain();

    // When
    const results = await search("exponential backoff retries");

    // Then
    const hit = results.find((r) => r.id === reference)!;
    expect(hit.via).toEqual({ node: anchor, edge: "references" });
  });

  it("should surface nothing from the graph when expansion is off", async () => {
    // Given
    const { reference, distant } = await chain();

    // When
    const results = await search("exponential backoff retries", { expand_graph: false });

    // Then
    expect(results.map((r) => r.id)).not.toContain(reference);
    expect(results.map((r) => r.id)).not.toContain(distant);
  });

  it("should keep every graph hit below the best direct hit", async () => {
    // Given
    await chain();

    // When
    const results = await search("exponential backoff retries");

    // Then
    const direct = results.filter((r) => r.matched !== "graph");
    const graph = results.filter((r) => r.matched === "graph");
    expect(direct.length).toBeGreaterThan(0);
    expect(graph.length).toBeGreaterThan(0);
    expect(results.indexOf(direct[0]!)).toBe(0);
  });

  it("should rank a node backed by two seeds above one backed by a single seed", async () => {
    // Given
    const topic = "the http client retries with exponential backoff";
    const seedA = await write("Retry budget", topic);
    const seedB = await write("Client retries", topic);
    const shared = await write("Shared runbook", "operational runbook for the platform team");
    const single = await write("Single note", "an isolated operational note");

    await link(seedA.id, shared.id, EdgeType.REFERENCES);
    await link(seedB.id, shared.id, EdgeType.REFERENCES);
    await link(seedA.id, single.id, EdgeType.REFERENCES);

    // When
    const results = await search("exponential backoff retries");

    // Then
    const ids = results.map((r) => r.id);
    expect(ids.indexOf(shared.id)).toBeLessThan(ids.indexOf(single.id));
  });

  it("should never surface a superseded node through the graph", async () => {
    // Given
    const anchor = await write("Retry budget", "the http client retries with exponential backoff");
    const stale = await write("Old retry note", "the api gateway routes tenant traffic");
    const fresh = await write("New retry note", "the api gateway routes tenant traffic today");

    await link(anchor.id, stale.id, EdgeType.REFERENCES);
    await container.resolve(InvalidateTool).invoke({
      session_id: session,
      id: stale.id,
      reason: "replaced by the current note",
      superseded_by: fresh.id,
    });

    // When
    const results = await search("exponential backoff retries");

    // Then
    expect(results.map((r) => r.id)).not.toContain(stale.id);
  });

  it("should return the same order when an identical search is repeated", async () => {
    // Given
    await chain();

    // When
    const first = (await search("exponential backoff retries")).map((r) => r.id);
    const second = (await search("exponential backoff retries")).map((r) => r.id);

    // Then
    expect(second).toEqual(first);
  });
});
