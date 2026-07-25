import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import { chunkContent } from "@/core/chunk";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { UpdateTool } from "../src/tools/update";

const session_start = new SessionStartTool();
const write = new WriteTool();
const update = new UpdateTool();

const NOTE = `# Intro
This is the introduction paragraph with enough words to stand on its own as a chunk.

## Ranking
Ranking blends full text search with vector similarity via reciprocal rank fusion.

## Decay
Episodic memories decay with age while semantic facts stay steady over time.`;

async function session(ctx: Ctx): Promise<string> {
  return (await session_start.invoke(ctx, {})).session_id;
}

describe("content-addressed chunking", () => {
  it("splits a 3-section note into 3 heading-scoped chunks", () => {
    const chunks = chunkContent("n1", NOTE);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.heading_path)).toEqual([
      "H1: Intro",
      "H1: Intro > H2: Ranking",
      "H1: Intro > H2: Decay",
    ]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  it("editing one section leaves the other chunk ids untouched", () => {
    const before = chunkContent("n1", NOTE);
    const edited = NOTE.replace(
      "via reciprocal rank fusion",
      "via reciprocal rank fusion, tuned carefully",
    );
    const after = chunkContent("n1", edited);

    const beforeIds = new Set(before.map((c) => c.id));
    const afterIds = new Set(after.map((c) => c.id));
    expect([...afterIds].filter((id) => beforeIds.has(id)).length).toBe(2); // Intro + Decay unchanged
    expect([...afterIds].filter((id) => !beforeIds.has(id)).length).toBe(1); // Ranking is new
  });

  it("ids are stable across nodes only via node_id (no cross-node collision)", () => {
    const a = chunkContent("nodeA", NOTE)[0]!;
    const b = chunkContent("nodeB", NOTE)[0]!;
    expect(a.id).not.toBe(b.id);
  });
});

describe("embedding diff: only genuinely-new chunks re-embed", () => {
  it("re-embeds exactly the changed section on update", async () => {
    const { ctx, repo, worker, db } = makeCtx();
    const s = await session(ctx);
    const node = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "howto",
      title: "Retrieval",
      content: NOTE,
    })) as unknown as Envelope;

    const first = await worker.tick();
    expect(first.embedded).toBe(3); // all three chunks embedded on first drain
    expect((db.prepare("SELECT COUNT(*) c FROM embedding_meta").get() as { c: number }).c).toBe(3);

    const edited = NOTE.replace(
      "via reciprocal rank fusion",
      "via reciprocal rank fusion, tuned carefully",
    );
    await update.invoke(ctx, {
      session_id: s,
      id: node.id,
      content: edited,
      reason: "tune ranking",
    });

    // Diff should queue exactly one new chunk; the other two keep their vectors.
    expect(repo.unembeddedChunks([node.id], 16).length).toBe(1);
    const second = await worker.tick();
    expect(second.embedded).toBe(1);
  });
});
