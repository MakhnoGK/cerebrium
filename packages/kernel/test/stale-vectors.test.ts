import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const LONG = Array.from({ length: 12 }, (_, i) => `## Heading ${i}\n${"body text ".repeat(60)}`);

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeLong(s: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: "A node with many chunks",
    content: LONG.join("\n\n"),
  });
}

async function drain(env: TestEnv): Promise<void> {
  for (let i = 0; i < 50 && (await env.queue.embeddingStats()).backlog > 0; i++) {
    await env.worker.tick();
  }
}

async function staleWithVectors(env: TestEnv): Promise<number> {
  return (await env.sql.one<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM chunks c
     JOIN chunk_vectors v ON v.chunk_id = c.id WHERE c.stale = 1`,
  ))!.c;
}

async function staleChunks(env: TestEnv): Promise<number> {
  return (await env.sql.one<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM chunks WHERE stale = 1",
  ))!.c;
}

async function liveCoverage(
  env: TestEnv,
  node: string,
): Promise<{ total: number; embedded: number }> {
  return (await env.sql.one<{ total: number; embedded: number }>(
    `SELECT COUNT(*)::int AS total, COUNT(v.chunk_id)::int AS embedded FROM chunks c
     LEFT JOIN chunk_vectors v ON v.chunk_id = c.id WHERE c.node_id = @node AND c.stale = 0`,
    { node },
  ))!;
}

describe("Stale chunk vectors", () => {
  it("should drop the vector when a revision supersedes a chunk", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);
    expect(await staleChunks(env)).toBe(0);

    // When
    await container.resolve(UpdateTool).invoke({
      session_id: s,
      id: node.id,
      content: "a much shorter body that keeps none of the old chunks",
    });
    await drain(env);

    // Then
    expect(await staleChunks(env)).toBeGreaterThan(0);
    expect(await staleWithVectors(env)).toBe(0);
  });

  it("should keep the node's live chunks embedded when its stale ones are dropped", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);

    // When
    await container.resolve(UpdateTool).invoke({
      session_id: s,
      id: node.id,
      content: `${LONG[0]!}\n\n## A new heading\n${"different words ".repeat(60)}`,
    });
    await drain(env);

    // Then
    const live = await liveCoverage(env, node.id);
    expect(live.total).toBeGreaterThan(0);
    expect(live.embedded).toBe(live.total);
  });

  it("should re-embed a chunk that a later revision brings back", async () => {
    // Given
    const env = setup();
    const s = await session();
    const node = await writeLong(s);
    await drain(env);
    const update = container.resolve(UpdateTool);
    await update.invoke({ session_id: s, id: node.id, content: "an unrelated short body" });
    await drain(env);

    // When — the original text returns, reviving the content-addressed chunk ids.
    await update.invoke({ session_id: s, id: node.id, content: LONG.join("\n\n") });
    await drain(env);

    // Then
    const live = await liveCoverage(env, node.id);
    expect(live.embedded).toBe(live.total);
  });
});
