import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { EmbeddingRole } from "@/domain/ports/embedding-provider";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}

async function writeFact(s: string, title: string): Promise<Envelope> {
  return container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a few words of body text`,
  });
}

async function drain(env: TestEnv): Promise<void> {
  for (let i = 0; i < 200 && (await env.queue.embeddingStats()).backlog > 0; i++) {
    await env.worker.tick();
  }
}

async function query(env: TestEnv, text: string): Promise<number[]> {
  const [vec] = await env.provider.embed([text], EmbeddingRole.QUERY);
  return vec!;
}

describe("Authored vector candidates", () => {
  it("should make every live authored node a candidate when the authored pool fits under k", async () => {
    // Given
    const env = setup();
    const s = await session();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await writeFact(s, `Fact ${i}`)).id);
    await drain(env);

    // When
    const rows = await env.search.vectorSearch(await query(env, "anything at all"), {
      kinds: [MemoryKind.SEMANTIC],
      history: false,
      cap: 100,
    });

    // Then
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
  });
});
