import { describe, it, expect } from "vitest";
import { container } from "tsyringe";
import { setup } from "@test/helpers";
import { _MemoryKind } from "@/core/vocab";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";
import { GetTool } from "../src/tools/get";
import { UpdateTool } from "../src/tools/update";
import { InvalidateTool } from "../src/tools/invalidate";
import { SearchTool } from "../src/tools/search";

function tools() {
  return {
    sessionStart: container.resolve(SessionStartTool),
    write: container.resolve(WriteTool),
    get: container.resolve(GetTool),
    update: container.resolve(UpdateTool),
    invalidate: container.resolve(InvalidateTool),
    search: container.resolve(SearchTool),
  };
}

function env(x: unknown): Envelope {
  return x as Envelope;
}
function gnodes(res: unknown): Record<string, unknown>[] {
  return (res as { nodes: Record<string, unknown>[] }).nodes;
}

describe("Revisions are append-only and history is reconstructable", () => {
  it("should keep old revisions readable after an update", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    const created = env(
      await t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "Fact",
        content: "content A",
      }),
    );
    expect(created.rev).toBe(1);

    // When
    const updated = env(
      await t.update.invoke({
        session_id: s,
        id: created.id,
        content: "content B",
        reason: "refined",
      }),
    );

    // Then
    expect(updated.rev).toBe(2);
    const current = gnodes(await t.get.invoke({ session_id: s, ids: [created.id] }))[0] as {
      content: string;
    };
    expect(current.content).toBe("content B");

    const old = gnodes(await t.get.invoke({ session_id: s, ids: [created.id], rev: 1 }))[0] as {
      content: string;
      shown_rev: number;
    };
    expect(old.content).toBe("content A");
    expect(old.shown_rev).toBe(1);

    const withRevs = gnodes(
      await t.get.invoke({ session_id: s, ids: [created.id], include_revisions: true }),
    )[0] as {
      revisions: { rev: number; reason: string | null }[];
    };
    expect(withRevs.revisions.map((r) => r.rev)).toEqual([1, 2]);
    expect(withRevs.revisions[1]!.reason).toBe("refined");
  });
});

describe("Episodic memories are write-once", () => {
  it("should refuse to update an episodic node", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    const note = env(
      await t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.EPISODIC,
        type: "event_note",
        title: "E",
        content: "happened",
      }),
    );

    // When / Then
    await expect(
      t.update.invoke({ session_id: s, id: note.id, content: "changed" }),
    ).rejects.toThrow(/write-once/);
  });
});

describe("Invalidate is a soft delete with a supersedes edge", () => {
  it("should mark the node invalid and link the replacement", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    const oldNode = env(
      await t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "Old",
        content: "old truth",
      }),
    );
    const newNode = env(
      await t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "New",
        content: "new truth",
      }),
    );

    // When
    const inv = env(
      await t.invalidate.invoke({
        session_id: s,
        id: oldNode.id,
        reason: "replaced",
        superseded_by: newNode.id,
      }),
    );

    // Then
    expect(inv.invalidated).toBe(true);
    const newFull = gnodes(await t.get.invoke({ session_id: s, ids: [newNode.id] }))[0] as {
      edges: { id: string; edge: string; direction: string }[];
    };
    expect(newFull.edges).toContainEqual(
      expect.objectContaining({ id: oldNode.id, edge: "supersedes", direction: "out" }),
    );
  });
});

describe("FTS stays consistent across write -> update -> invalidate", () => {
  it("should index current content only and exclude invalidated nodes unless history", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    const n = env(
      await t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "Fruit",
        content: "banana",
      }),
    );
    expect(
      (await t.search.invoke({ session_id: s, query: "banana", limit: 10 })).total_matches,
    ).toBe(1);

    // When / Then — update swaps the indexed term.
    await t.update.invoke({ session_id: s, id: n.id, content: "cherry" });
    expect(
      (await t.search.invoke({ session_id: s, query: "banana", limit: 10 })).total_matches,
    ).toBe(0);
    expect(
      (await t.search.invoke({ session_id: s, query: "cherry", limit: 10 })).total_matches,
    ).toBe(1);

    // When / Then — invalidate hides it from normal search but not from history.
    await t.invalidate.invoke({ session_id: s, id: n.id, reason: "gone" });
    expect(
      (await t.search.invoke({ session_id: s, query: "cherry", limit: 10 })).total_matches,
    ).toBe(0);

    const hist = await t.search.invoke({
      session_id: s,
      query: "cherry",
      history: true,
      limit: 10,
    });
    expect(hist.total_matches).toBe(1);
    expect(hist.results[0]!.invalidated).toBe(true);
  });
});

describe("Write validation guards the data model", () => {
  it("should reject mirror writes since mirrors are indexer-managed", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When / Then
    await expect(
      t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.MIRROR,
        type: "fact",
        title: "M",
        content: "x",
      }),
    ).rejects.toThrow(/indexer|code_index/);
  });

  it("should reject a type that does not belong to the kind", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When / Then
    await expect(
      t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "checkpoint",
        title: "X",
        content: "x",
      }),
    ).rejects.toThrow(/not valid for semantic/);
  });

  it("should reject oversized content", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When / Then
    await expect(
      t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "Big",
        content: "x".repeat(50_001),
      }),
    ).rejects.toThrow(/split/i);
  });

  it("should reject links to non-existent destinations", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When / Then
    await expect(
      t.write.invoke({
        session_id: s,
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "L",
        content: "x",
        links: [{ dst: "01NONEXISTENT", type: "references" }],
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("Unknown sessions are forgiven", () => {
  it("should auto-create a session and hint about it when the id is unknown", async () => {
    // Given
    setup();
    const t = tools();

    // When
    const res = env(
      await t.write.invoke({
        session_id: "GHOST",
        memory_kind: _MemoryKind.SEMANTIC,
        type: "fact",
        title: "T",
        content: "x",
      }),
    );

    // Then
    expect((res as unknown as { hints: string[] }).hints[0]).toMatch(/Unknown session_id/);
  });
});
