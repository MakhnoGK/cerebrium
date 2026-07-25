import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { GetTool } from "../src/tools/get";
import { UpdateTool } from "../src/tools/update";
import { InvalidateTool } from "../src/tools/invalidate";
import { SearchTool } from "../src/tools/search";

const session_start = new SessionStartTool();
const write = new WriteTool();
const get = new GetTool();
const update = new UpdateTool();
const invalidate = new InvalidateTool();
const search = new SearchTool();

async function newSession(ctx: Ctx, project?: string): Promise<string> {
  const res = await session_start.invoke(ctx, { project });
  return res.session_id;
}

function env(x: unknown): Envelope {
  return x as Envelope;
}

function gnodes(res: unknown): Record<string, unknown>[] {
  return (res as { nodes: Record<string, unknown>[] }).nodes;
}

describe("revisions are append-only and history is reconstructable", () => {
  it("keeps old revisions readable after an update", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    const created = env(
      await write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: "Fact",
        content: "content A",
      }),
    );
    expect(created.rev).toBe(1);

    const updated = env(
      await update.invoke(ctx, {
        session_id: s,
        id: created.id,
        content: "content B",
        reason: "refined",
      }),
    );
    expect(updated.rev).toBe(2);

    const current = gnodes(await get.invoke(ctx, { session_id: s, ids: [created.id] }))[0] as {
      content: string;
    };
    expect(current.content).toBe("content B");

    const old = gnodes(await get.invoke(ctx, { session_id: s, ids: [created.id], rev: 1 }))[0] as {
      content: string;
      shown_rev: number;
    };
    expect(old.content).toBe("content A");
    expect(old.shown_rev).toBe(1);

    const withRevs = gnodes(
      await get.invoke(ctx, { session_id: s, ids: [created.id], include_revisions: true }),
    )[0] as {
      revisions: { rev: number; reason: string | null }[];
    };
    expect(withRevs.revisions.map((r) => r.rev)).toEqual([1, 2]);
    expect(withRevs.revisions[1]!.reason).toBe("refined");
  });
});

describe("episodic memories are write-once", () => {
  it("refuses to update an episodic node", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    const note = env(
      await write.invoke(ctx, {
        session_id: s,
        memory_kind: "episodic",
        type: "event_note",
        title: "E",
        content: "happened",
      }),
    );
    await expect(
      update.invoke(ctx, { session_id: s, id: note.id, content: "changed" }),
    ).rejects.toThrow(/write-once/);
  });
});

describe("invalidate is a soft delete with a supersedes edge", () => {
  it("marks the node invalid and links the replacement", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    const oldNode = env(
      await write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: "Old",
        content: "old truth",
      }),
    );
    const newNode = env(
      await write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: "New",
        content: "new truth",
      }),
    );

    const inv = env(
      await invalidate.invoke(ctx, {
        session_id: s,
        id: oldNode.id,
        reason: "replaced",
        superseded_by: newNode.id,
      }),
    );
    expect(inv.invalidated).toBe(true);

    const newFull = gnodes(await get.invoke(ctx, { session_id: s, ids: [newNode.id] }))[0] as {
      edges: { id: string; edge: string; direction: string }[];
    };
    expect(newFull.edges).toContainEqual(
      expect.objectContaining({ id: oldNode.id, edge: "supersedes", direction: "out" }),
    );
  });
});

describe("FTS stays consistent across write -> update -> invalidate", () => {
  it("indexes current content only, and excludes invalidated unless history", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    const n = env(
      await write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: "Fruit",
        content: "banana",
      }),
    );

    expect(
      (await search.invoke(ctx, { session_id: s, query: "banana", limit: 10 })).total_matches,
    ).toBe(1);

    await update.invoke(ctx, { session_id: s, id: n.id, content: "cherry" });
    expect(
      (await search.invoke(ctx, { session_id: s, query: "banana", limit: 10 })).total_matches,
    ).toBe(0);
    expect(
      (await search.invoke(ctx, { session_id: s, query: "cherry", limit: 10 })).total_matches,
    ).toBe(1);

    await invalidate.invoke(ctx, { session_id: s, id: n.id, reason: "gone" });
    expect(
      (await search.invoke(ctx, { session_id: s, query: "cherry", limit: 10 })).total_matches,
    ).toBe(0);

    const hist = await search.invoke(ctx, {
      session_id: s,
      query: "cherry",
      history: true,
      limit: 10,
    });
    expect(hist.total_matches).toBe(1);
    expect((hist.results as Envelope[])[0]!.invalidated).toBe(true);
  });
});

describe("write validation guards the data model", () => {
  it("rejects mirror writes — mirrors are indexer-managed", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    await expect(
      write.invoke(ctx, {
        session_id: s,
        memory_kind: "mirror",
        type: "fact",
        title: "M",
        content: "x",
      }),
    ).rejects.toThrow(/indexer|code_index/);
  });

  it("rejects a type that doesn't belong to the kind", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    await expect(
      write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "checkpoint",
        title: "X",
        content: "x",
      }),
    ).rejects.toThrow(/not valid for semantic/);
  });

  it("rejects oversized content", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    await expect(
      write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: "Big",
        content: "x".repeat(50_001),
      }),
    ).rejects.toThrow(/split/i);
  });

  it("rejects links to non-existent destinations", async () => {
    const { ctx } = makeCtx();
    const s = await newSession(ctx);
    await expect(
      write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title: "L",
        content: "x",
        links: [{ dst: "01NONEXISTENT", type: "references" }],
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("unknown sessions are forgiven", () => {
  it("auto-creates a session and hints about it", async () => {
    const { ctx } = makeCtx();
    const res = env(
      await write.invoke(ctx, {
        session_id: "GHOST",
        memory_kind: "semantic",
        type: "fact",
        title: "T",
        content: "x",
      }),
    );
    expect((res as unknown as { hints: string[] }).hints[0]).toMatch(/Unknown session_id/);
  });
});
