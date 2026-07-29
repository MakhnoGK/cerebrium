import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { chunkContent } from "@/core/chunk";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const NOTE = `# Intro
This is the introduction paragraph with enough words to stand on its own as a chunk.

## Ranking
Ranking blends full text search with vector similarity via reciprocal rank fusion.

## Decay
Episodic memories decay with age while semantic facts stay steady over time.`;

describe("Content-addressed chunking", () => {
  it("should split a 3-section note into 3 heading-scoped chunks", () => {
    // Given / When
    const chunks = chunkContent("n1", NOTE);

    // Then
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.heading_path)).toEqual([
      "H1: Intro",
      "H1: Intro > H2: Ranking",
      "H1: Intro > H2: Decay",
    ]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it("should leave the other chunk ids untouched when one section is edited", () => {
    // Given
    const before = chunkContent("n1", NOTE);

    // When
    const edited = NOTE.replace(
      "via reciprocal rank fusion",
      "via reciprocal rank fusion, tuned carefully",
    );
    const after = chunkContent("n1", edited);

    // Then
    const beforeIds = new Set(before.map((c) => c.id));
    const afterIds = new Set(after.map((c) => c.id));
    expect([...afterIds].filter((id) => beforeIds.has(id)).length).toBe(2); // Intro + Decay unchanged
    expect([...afterIds].filter((id) => !beforeIds.has(id)).length).toBe(1); // Ranking is new
  });

  it("should not collide chunk ids across nodes since they key on node_id", () => {
    // Given / When
    const a = chunkContent("nodeA", NOTE)[0]!;
    const b = chunkContent("nodeB", NOTE)[0]!;

    // Then
    expect(a.id).not.toBe(b.id);
  });
});

describe("Embedding diff: only genuinely-new chunks re-embed", () => {
  it("should re-embed exactly the changed section when a note is updated", async () => {
    // Given
    const env = setup();
    const write = container.resolve(WriteTool);
    const update = container.resolve(UpdateTool);
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const node = (await write.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "howto",
      title: "Retrieval",
      content: NOTE,
    })) as unknown as Envelope;

    // When
    const first = await env.worker.tick();

    // Then
    expect(first.embedded).toBe(3); // all three chunks embedded on first drain
    expect((env.db.prepare("SELECT COUNT(*) c FROM embedding_meta").get() as { c: number }).c).toBe(
      3,
    );

    // When — edit one section only.
    const edited = NOTE.replace(
      "via reciprocal rank fusion",
      "via reciprocal rank fusion, tuned carefully",
    );
    await update.invoke({ session_id: s, id: node.id, content: edited, reason: "tune ranking" });

    // Then — the diff queues exactly one new chunk; the other two keep their vectors.
    expect(env.queue.unembeddedChunks([node.id], 16).length).toBe(1);
    const second = await env.worker.tick();
    expect(second.embedded).toBe(1);
  });
});
