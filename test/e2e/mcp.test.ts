import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "@/db/database";
import { buildCtx, createServer } from "@/server";

async function connect() {
  const ctx = buildCtx(openDatabase(":memory:"));
  const server = createServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function payload(res: unknown): Record<string, unknown> {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("MCP wire layer", () => {
  it("exposes all sixteen tools with descriptions", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "checkpoint",
      "code_index",
      "code_lookup",
      "consolidate_apply",
      "consolidate_suggest",
      "get",
      "invalidate",
      "link",
      "mirror_status",
      "mirror_upsert",
      "search",
      "session_start",
      "source_register",
      "stats",
      "update",
      "write",
    ]);

    for (const t of tools) expect(t.description?.length).toBeGreaterThan(20);
  });

  it("round-trips a write → search → get through the transport", async () => {
    const client = await connect();
    const start = payload(await client.callTool({ name: "session_start", arguments: {} }));
    const sid = start.session_id as string;

    expect(sid).toBeTruthy();

    const written = payload(
      await client.callTool({
        name: "write",
        arguments: {
          session_id: sid,
          memory_kind: "semantic",
          type: "fact",
          title: "Wire",
          content: "hello over MCP",
        },
      }),
    );

    expect(written.id).toBeTruthy();

    const found = payload(
      await client.callTool({ name: "search", arguments: { session_id: sid, query: "hello" } }),
    );

    expect(found.total_matches).toBe(1);

    const got = payload(
      await client.callTool({ name: "get", arguments: { session_id: sid, ids: [written.id] } }),
    );

    expect((got.nodes as { content: string }[])[0]!.content).toBe("hello over MCP");
  });

  it("returns an actionable error for an episodic update", async () => {
    const client = await connect();
    const start = payload(await client.callTool({ name: "session_start", arguments: {} }));
    const sid = start.session_id as string;
    const note = payload(
      await client.callTool({
        name: "write",
        arguments: {
          session_id: sid,
          memory_kind: "episodic",
          type: "event_note",
          title: "E",
          content: "x",
        },
      }),
    );

    const res = (await client.callTool({
      name: "update",
      arguments: { session_id: sid, id: note.id, content: "y" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/write-once/);
  });
});
