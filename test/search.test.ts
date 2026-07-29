import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

function tools() {
  return {
    sessionStart: container.resolve(SessionStartTool),
    write: container.resolve(WriteTool),
    search: container.resolve(SearchTool),
  };
}

function ids(res: { results: Envelope[] }): string[] {
  return res.results.map((e) => e.id);
}

describe("Ranking blends text relevance with the memory model", () => {
  it("should rank a semantic fact above a fresh episodic above a 60-day-old one", async () => {
    // Given
    const env = setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    const content = "deploy the release pipeline";

    const old = (await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "checkpoint",
      title: "Deploy",
      content,
    })) as Envelope;
    env.clock.advanceDays(59);
    const fresh = (await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "checkpoint",
      title: "Deploy",
      content,
    })) as Envelope;
    env.clock.advanceDays(1);
    const fact = (await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Deploy",
      content,
    })) as Envelope;

    // When
    const res = await t.search.invoke({ session_id: s, query: "deploy pipeline", limit: 10 });

    // Then
    expect(ids(res)).toEqual([fact.id, fresh.id, old.id]);
  });

  it("should let a stronger-but-older text match win under history:true (decay dropped)", async () => {
    // Given
    const env = setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    const old = (await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "checkpoint",
      title: "x",
      content: "deploy deploy deploy deploy pipeline",
    })) as Envelope;
    env.clock.advanceDays(60);
    const fresh = (await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "checkpoint",
      title: "x",
      content: "deploy",
    })) as Envelope;

    // When / Then — decay sinks the old one under normal search.
    const normal = await t.search.invoke({ session_id: s, query: "deploy", limit: 10 });
    expect(ids(normal)[0]).toBe(fresh.id);

    // When / Then — no decay under history: the stronger text match wins.
    const hist = await t.search.invoke({
      session_id: s,
      query: "deploy",
      history: true,
      limit: 10,
    });
    expect(ids(hist)[0]).toBe(old.id);
  });
});

describe("Search is robust and filterable", () => {
  it("should never throw on a malformed query", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "T",
      content: "alpha beta",
    });

    // When
    const res = await t.search.invoke({ session_id: s, query: 'alpha AND ) OR * "', limit: 10 });

    // Then
    expect(res.total_matches).toBe(1);
  });

  it("should return nothing without error for an all-punctuation query", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When
    const res = await t.search.invoke({ session_id: s, query: "!!! ??? ...", limit: 10 });

    // Then
    expect(res.total_matches).toBe(0);
    expect(res.results).toEqual([]);
  });

  it("should filter by kind and type when those filters are supplied", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;
    await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "A",
      content: "shared term",
    });
    await t.write.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "event_note",
      title: "B",
      content: "shared term",
    });

    // When
    const onlySemantic = await t.search.invoke({
      session_id: s,
      query: "shared",
      kinds: [MemoryKind.SEMANTIC],
      limit: 10,
    });

    // Then
    expect(onlySemantic.total_matches).toBe(1);
    expect(onlySemantic.results[0]!.kind).toBe("semantic");
  });
});
