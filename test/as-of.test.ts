import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { GetTool } from "@/presentation/mcp/tools/get";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

const JANUARY = "2026-01-01T00:00:00.000Z";
const TOPIC = "the http client retries with exponential backoff";

let env: TestEnv;
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

function get(ids: string[], extra: { as_of?: string; rev?: number } = {}) {
  return container.resolve(GetTool).invoke({ session_id: session, ids, ...extra });
}

async function search(as_of?: string): Promise<string[]> {
  const res = await container
    .resolve(SearchTool)
    .invoke({ session_id: session, query: "exponential backoff retries", limit: 10, as_of });

  return res.results.map((r) => r.id);
}

beforeEach(async () => {
  env = setup({ start: JANUARY });
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Reading a node as of a past instant", () => {
  it("should return the revision that was current then, not the latest", async () => {
    // Given
    const node = await write("Retry budget", "retries are capped at three attempts");
    env.clock.advanceDays(10);
    const midpoint = env.clock.t;
    env.clock.advanceDays(10);
    await container.resolve(UpdateTool).invoke({
      session_id: session,
      id: node.id,
      content: "retries are capped at five attempts",
      reason: "policy changed",
    });

    // When
    const past = (await get([node.id], { as_of: midpoint })) as {
      nodes: { content: string; shown_rev: number }[];
    };
    const now = (await get([node.id])) as { nodes: { content: string }[] };

    // Then
    expect(past.nodes[0]!.content).toContain("three attempts");
    expect(past.nodes[0]!.shown_rev).toBe(1);
    expect(now.nodes[0]!.content).toContain("five attempts");
  });

  it("should report a node that did not exist yet as not found", async () => {
    // Given
    env.clock.advanceDays(10);
    const node = await write("Retry budget", TOPIC);

    // When
    const res = (await get([node.id], { as_of: JANUARY })) as {
      nodes: unknown[];
      not_found?: string[];
    };

    // Then
    expect(res.nodes).toHaveLength(0);
    expect(res.not_found).toEqual([node.id]);
  });

  it("should report a node invalidated before that instant as not found", async () => {
    // Given
    const node = await write("Retry budget", TOPIC);
    env.clock.advanceDays(5);
    await container
      .resolve(InvalidateTool)
      .invoke({ session_id: session, id: node.id, reason: "superseded by the new policy" });
    env.clock.advanceDays(5);

    // When
    const res = (await get([node.id], { as_of: env.clock.t })) as { not_found?: string[] };

    // Then
    expect(res.not_found).toEqual([node.id]);
  });

  it("should refuse to combine as_of with rev", async () => {
    // Given
    const node = await write("Retry budget", TOPIC);

    // When / Then
    await expect(get([node.id], { as_of: env.clock.t, rev: 1 })).rejects.toThrow(/pass one/);
  });
});

describe("Searching the store as of a past instant", () => {
  it("should exclude a node written after that instant", async () => {
    // Given
    const early = await write("Retry budget", TOPIC);
    env.clock.advanceDays(10);
    const cutoff = env.clock.t;
    env.clock.advanceDays(10);
    const late = await write("Client retries", TOPIC);
    await env.worker.tick();

    // When
    const ids = await search(cutoff);

    // Then
    expect(ids).toContain(early.id);
    expect(ids).not.toContain(late.id);
  });

  it("should include a node that was valid then even though it is invalidated now", async () => {
    // Given
    const node = await write("Retry budget", TOPIC);
    await env.worker.tick();
    env.clock.advanceDays(10);
    const cutoff = env.clock.t;
    env.clock.advanceDays(10);
    await container
      .resolve(InvalidateTool)
      .invoke({ session_id: session, id: node.id, reason: "policy replaced" });

    // When / Then
    expect(await search()).not.toContain(node.id);
    // When / Then
    expect(await search(cutoff)).toContain(node.id);
  });

  it("should not let graph expansion surface a node written after that instant", async () => {
    // Given
    const anchor = await write("Retry budget", TOPIC);
    env.clock.advanceDays(10);
    const cutoff = env.clock.t;
    env.clock.advanceDays(10);
    const later = await write("Gateway config", "the api gateway routes tenant traffic");
    await container
      .resolve(LinkTool)
      .invoke({ session_id: session, src: anchor.id, dst: later.id, type: EdgeType.REFERENCES });

    // When
    const ids = await search(cutoff);

    // Then
    expect(ids).toContain(anchor.id);
    expect(ids).not.toContain(later.id);
  });

  it("should rank identically to an unrestricted search when as_of is omitted", async () => {
    // Given
    await write("Retry budget", TOPIC);
    await write("Client retries", TOPIC);
    await write("Kafka", "ingestion consumes kafka topics by tenant");
    await env.worker.tick();

    // When / Then
    expect(await search()).toEqual(await search());
  });
});
