import "reflect-metadata";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import type { Envelope } from "@/db/repo";
import { MemoryKind } from "@/core/vocab";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

const P = "auth-service";
const FACT =
  "Access tokens live fifteen minutes before they expire and must then be refreshed by the client";

type Result = Envelope & {
  matched: string;
  best_chunk?: string;
  via?: { node: string; edge: string };
};
function results(res: unknown): Result[] {
  return (res as { results: Result[] }).results;
}

describe("Retrieval lifecycle end-to-end", () => {
  it("should carry a fact through the full retrieval lifecycle", async () => {
    // Given
    const env = setup();
    const sessionStart = container.resolve(SessionStartTool);
    const write = container.resolve(WriteTool);
    const search = container.resolve(SearchTool);
    const invalidate = container.resolve(InvalidateTool);
    const s = (await sessionStart.invoke({ project: P })).session_id;

    // 1) write a fact -> immediately findable via FTS while pending_embedding = 1
    const fact = (await write.invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Token TTL",
      content: FACT,
      project: P,
    })) as unknown as Envelope;
    expect(
      (
        env.db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(fact.id) as {
          p: number;
        }
      ).p,
    ).toBe(1);
    const textHit = results(
      await search.invoke({
        session_id: s,
        query: "access tokens expire",
        project: P,
        mode: "text",
        limit: 10,
      }),
    );
    expect(textHit.some((r) => r.id === fact.id)).toBe(true);

    // vector search finds nothing yet (not embedded)
    const vecEmpty = results(
      await search.invoke({
        session_id: s,
        query: "access tokens expire",
        project: P,
        mode: "vector",
        limit: 10,
      }),
    );
    expect(vecEmpty.some((r) => r.id === fact.id)).toBe(false);

    // 2) worker drains -> vector search now finds it, with a best_chunk snippet
    await env.worker.tick();
    expect(
      (
        env.db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(fact.id) as {
          p: number;
        }
      ).p,
    ).toBe(0);
    const vecHit = results(
      await search.invoke({
        session_id: s,
        query: "access tokens expire",
        project: P,
        mode: "vector",
        limit: 10,
      }),
    );
    const hit = vecHit.find((r) => r.id === fact.id);
    expect(hit?.matched).toBe("vector");
    expect(hit?.best_chunk?.length).toBeGreaterThan(0);

    // 3) write a near-duplicate -> similar_existing returned
    const dup = (await write.invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title: "Token TTL",
      content: FACT,
      project: P,
    })) as { id: string; similar_existing?: { id: string }[] };
    expect(dup.similar_existing?.some((c) => c.id === fact.id)).toBe(true);

    // 4) invalidate the original with superseded_by -> only via history, never via graph
    await invalidate.invoke({
      session_id: s,
      id: fact.id,
      reason: "duplicate",
      superseded_by: dup.id,
    });

    const normal = results(
      await search.invoke({ session_id: s, query: "access tokens expire", project: P, limit: 10 }),
    );
    expect(normal.some((r) => r.id === fact.id)).toBe(false);

    const hist = results(
      await search.invoke({
        session_id: s,
        query: "access tokens expire",
        project: P,
        history: true,
        limit: 10,
      }),
    );
    const old = hist.find((r) => r.id === fact.id);
    expect(old?.invalidated).toBe(true);
    expect(hist.every((r) => !(r.id === fact.id && r.matched === "graph"))).toBe(true);
  });
});
