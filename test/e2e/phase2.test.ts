import { describe, it, expect } from "vitest";
import { makeCtx } from "../helpers";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../../src/tools/session_start";
import { WriteTool } from "../../src/tools/write";
import { SearchTool } from "../../src/tools/search";
import { InvalidateTool } from "../../src/tools/invalidate";

const session_start = new SessionStartTool();
const write = new WriteTool();
const search = new SearchTool();
const invalidate = new InvalidateTool();

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

// Acceptance §9.3: write → FTS-findable while pending → worker drains → vector-findable
// → near-duplicate flagged → invalidate w/ superseded_by → old node only via history,
// never via graph expansion.
describe("phase 2 end-to-end retrieval lifecycle", () => {
  it("carries a fact through the full retrieval lifecycle", async () => {
    const { ctx, repo, worker, db } = makeCtx();
    const s = (await session_start.invoke(ctx, { project: P })).session_id;

    // 1) write a fact → immediately findable via FTS while pending_embedding = 1
    const fact = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Token TTL",
      content: FACT,
      project: P,
    })) as unknown as Envelope;

    expect(
      (db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(fact.id) as { p: number })
        .p,
    ).toBe(1);
    const textHit = results(
      await search.invoke(ctx, {
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
      await search.invoke(ctx, {
        session_id: s,
        query: "access tokens expire",
        project: P,
        mode: "vector",
        limit: 10,
      }),
    );
    expect(vecEmpty.some((r) => r.id === fact.id)).toBe(false);

    // 2) worker drains → vector search now finds it, with a best_chunk snippet
    await worker.tick();
    expect(
      (db.prepare("SELECT pending_embedding p FROM nodes WHERE id=?").get(fact.id) as { p: number })
        .p,
    ).toBe(0);
    const vecHit = results(
      await search.invoke(ctx, {
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

    // 3) write a near-duplicate → similar_existing returned
    const dup = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title: "Token TTL",
      content: FACT,
      project: P,
    })) as { id: string; similar_existing?: { id: string }[] };
    expect(dup.similar_existing?.some((c) => c.id === fact.id)).toBe(true);

    // 4) invalidate the original with superseded_by → only via history, never via graph
    await invalidate.invoke(ctx, {
      session_id: s,
      id: fact.id,
      reason: "duplicate",
      superseded_by: dup.id,
    });

    const normal = results(
      await search.invoke(ctx, {
        session_id: s,
        query: "access tokens expire",
        project: P,
        limit: 10,
      }),
    );
    expect(normal.some((r) => r.id === fact.id)).toBe(false);

    const hist = results(
      await search.invoke(ctx, {
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

    void repo;
  });
});
