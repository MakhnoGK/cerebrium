import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { GetTool } from "@/presentation/mcp/tools/get";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

const TOPIC = "the http client retries with exponential backoff";
const JULY = "2026-07-01T00:00:00.000Z";
const AUGUST = "2026-08-01T00:00:00.000Z";
const SEPTEMBER = "2026-09-01T00:00:00.000Z";

let env: TestEnv;
let session: string;

function write(
  title: string,
  window: { event_from?: string; event_to?: string } = {},
): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: session,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: TOPIC,
    ...window,
  });
}

async function search(valid_at?: string, as_of?: string): Promise<string[]> {
  const res = await container.resolve(SearchTool).invoke({
    session_id: session,
    query: "exponential backoff retries",
    limit: 10,
    valid_at,
    as_of,
  });

  return res.results.map((r) => r.id);
}

beforeEach(async () => {
  env = setup({ start: "2026-10-01T00:00:00.000Z" });
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Recording when a fact was true", () => {
  it("should store and return a claimed window", async () => {
    // Given
    const node = await write("Daemon outage", { event_from: JULY, event_to: AUGUST });

    // When
    const res = (await container
      .resolve(GetTool)
      .invoke({ session_id: session, ids: [node.id] })) as {
      nodes: { event_from?: string; event_to?: string }[];
    };

    // Then
    expect(res.nodes[0]).toMatchObject({ event_from: JULY, event_to: AUGUST });
  });

  it("should leave a node written without a window unclaimed", async () => {
    // Given
    const node = await write("Retry budget");

    // When
    const row = env.db.prepare("SELECT event_from, event_to FROM nodes WHERE id = ?").get(node.id);

    // Then
    expect(row).toEqual({ event_from: null, event_to: null });
  });

  it("should refuse a window that ends before it starts", async () => {
    // Given / When / Then
    await expect(write("Impossible", { event_from: AUGUST, event_to: JULY })).rejects.toThrow(
      /cannot stop being true before it started/,
    );
  });

  it("should correct a window through update without minting a revision", async () => {
    // Given
    const node = await write("Daemon outage", { event_from: AUGUST });

    // When
    await container
      .resolve(UpdateTool)
      .invoke({ session_id: session, id: node.id, event_from: JULY });

    // Then
    const row = env.db.prepare("SELECT event_from FROM nodes WHERE id = ?").get(node.id);
    expect(row).toEqual({ event_from: JULY });
    const revs = env.db
      .prepare("SELECT count(*) AS n FROM revisions WHERE node_id = ?")
      .get(node.id) as { n: number };
    expect(revs.n).toBe(1);
  });
});

describe("Searching by when a fact was true", () => {
  it("should keep a node whose window contains the instant", async () => {
    // Given
    const node = await write("Daemon outage", { event_from: JULY, event_to: SEPTEMBER });
    await env.worker.tick();

    // When / Then
    expect(await search(AUGUST)).toContain(node.id);
  });

  it("should drop a node whose window closed before the instant", async () => {
    // Given
    const node = await write("Daemon outage", { event_from: JULY, event_to: AUGUST });
    await env.worker.tick();

    // When / Then
    expect(await search(SEPTEMBER)).not.toContain(node.id);
    // When / Then
    expect(await search()).toContain(node.id);
  });

  it("should keep a node that claims no window at all", async () => {
    // Given
    const node = await write("Retry budget");
    await env.worker.tick();

    // When / Then
    expect(await search(JULY)).toContain(node.id);
  });

  it("should apply the two axes independently when both are given", async () => {
    // Given
    const node = await write("Daemon outage", { event_from: JULY, event_to: SEPTEMBER });
    await env.worker.tick();
    const beforeItWasWritten = "2026-09-15T00:00:00.000Z";

    // When / Then
    // Valid in August, but this store did not know it until October.
    expect(await search(AUGUST)).toContain(node.id);
    // When / Then
    expect(await search(AUGUST, beforeItWasWritten)).not.toContain(node.id);
  });

  it("should rank identically to an unrestricted search when valid_at is omitted", async () => {
    // Given
    await write("Retry budget", { event_from: JULY });
    await write("Client retries");
    await env.worker.tick();

    // When / Then
    expect(await search()).toEqual(await search());
  });
});
