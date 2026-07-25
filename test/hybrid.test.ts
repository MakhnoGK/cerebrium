import { describe, it, expect } from "vitest";
import { makeCtx } from "@test/helpers";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { InvalidateTool } from "../src/tools/invalidate";
import { LinkTool } from "../src/tools/link";
import { SearchTool } from "../src/tools/search";

const session_start = new SessionStartTool();
const write = new WriteTool();
const invalidate = new InvalidateTool();
const link = new LinkTool();
const search = new SearchTool();

async function session(ctx: Ctx, project?: string): Promise<string> {
  return ((await session_start.invoke(ctx, { project })) as any).session_id;
}
function w(
  ctx: Ctx,
  s: string,
  kind: "semantic" | "episodic",
  type: string,
  title: string,
  content: string,
  project?: string,
) {
  return write.invoke(ctx, {
    session_id: s,
    memory_kind: kind,
    type,
    title,
    content,
    project,
  }) as Promise<unknown> as Promise<Envelope>;
}

type Result = Envelope & {
  matched: string;
  best_chunk?: string;
  via?: { node: string; edge: string };
};

function results(res: unknown): Result[] {
  return (res as { results: Result[] }).results;
}

describe("RRF fusion", () => {
  it("a node matched by both branches outranks a single-branch node", async () => {
    const { ctx, worker } = makeCtx();
    const s = await session(ctx);
    const body = "reciprocal rank fusion ranking algorithm for retrieval";

    const both = await w(ctx, s, "semantic", "fact", "Alpha", body);
    await worker.tick(); // embed Alpha -> it lands in the vector branch too

    const textOnly = await w(ctx, s, "semantic", "fact", "Beta", body); // not drained -> FTS only

    const res = results(
      await search.invoke(ctx, { session_id: s, query: "reciprocal rank fusion", limit: 10 }),
    );
    const alpha = res.find((r) => r.id === both.id)!;
    const beta = res.find((r) => r.id === textOnly.id)!;

    expect(alpha.matched).toBe("both");
    expect(beta.matched).toBe("text");
    expect(res.findIndex((r) => r.id === both.id)).toBeLessThan(
      res.findIndex((r) => r.id === textOnly.id),
    );
  });
});

describe("memory-model factors hold in hybrid mode", () => {
  it("semantic outranks fresh episodic outranks old episodic, with vectors present", async () => {
    const { ctx, clock, worker } = makeCtx();
    const s = await session(ctx);
    const content = "deploy the release pipeline";

    const old = await w(ctx, s, "episodic", "event_note", "Deploy", content);

    clock.advanceDays(59);

    const fresh = await w(ctx, s, "episodic", "event_note", "Deploy", content);

    clock.advanceDays(1);

    const fact = await w(ctx, s, "semantic", "fact", "Deploy", content);

    await worker.tick(); // embed all three -> vector branch active

    const res = results(
      await search.invoke(ctx, { session_id: s, query: "deploy pipeline", limit: 10 }),
    );

    expect(res.map((r) => r.id)).toEqual([fact.id, fresh.id, old.id]);
  });

  it("excludes superseded nodes from normal search and from graph expansion", async () => {
    const { ctx, worker } = makeCtx();
    const s = await session(ctx);
    const oldNode = await w(ctx, s, "semantic", "fact", "Old TTL", "access tokens live 15 minutes");
    const newNode = await w(ctx, s, "semantic", "fact", "New TTL", "access tokens live 10 minutes");

    await worker.tick();
    await invalidate.invoke(ctx, {
      session_id: s,
      id: oldNode.id,
      reason: "shortened",
      superseded_by: newNode.id,
    });

    const normal = results(
      await search.invoke(ctx, { session_id: s, query: "access tokens live minutes", limit: 10 }),
    );

    expect(normal.some((r) => r.id === oldNode.id)).toBe(false); // hidden
    expect(normal.some((r) => r.id === newNode.id)).toBe(true);

    const hist = await search.invoke(ctx, {
      session_id: s,
      query: "access tokens live minutes",
      history: true,
      limit: 10,
    });

    const histRows = results(hist);
    const oldHit = histRows.find((r) => r.id === oldNode.id);

    expect(oldHit?.invalidated).toBe(true); // visible under history, flagged
    // superseded node never arrives via graph expansion (supersedes weight 0 + invalidated)
    expect(histRows.every((r) => !(r.id === oldNode.id && r.matched === "graph"))).toBe(true);

    const notes = (hist as { context_notes?: string[] }).context_notes ?? [];

    expect(notes.some((n) => n.includes(oldNode.id) && n.includes(newNode.id))).toBe(true);
  });
});

describe("graph expansion", () => {
  it("surfaces a documents-linked neighbor with a correct via edge", async () => {
    const { ctx } = makeCtx();
    const s = await session(ctx);
    // Neither embedded (no tick): FTS finds the how-to, graph pulls in the entity.
    const howto = await w(
      ctx,
      s,
      "semantic",
      "howto",
      "Deploy billing",
      "how to deploy the billing pipeline runbook steps",
    );
    const entity = await w(
      ctx,
      s,
      "semantic",
      "entity",
      "PaymentService",
      "PaymentService internal component details",
    );
    await link.invoke(ctx, { session_id: s, src: howto.id, dst: entity.id, type: "documents" });

    const res = results(
      await search.invoke(ctx, { session_id: s, query: "billing pipeline deploy", limit: 10 }),
    );

    const surfaced = res.find((r) => r.id === entity.id);

    expect(surfaced).toBeDefined();
    expect(surfaced!.matched).toBe("graph");
    expect(surfaced!.via).toEqual({ node: howto.id, edge: "documents" });
  });
});

describe("mode variants", () => {
  it("mode:'vector' finds a node only after it is embedded, with a best_chunk", async () => {
    const { ctx, worker } = makeCtx();
    const s = await session(ctx);
    const node = await w(
      ctx,
      s,
      "semantic",
      "fact",
      "Kafka",
      "the ingestion service consumes from kafka topics",
    );

    const before = results(
      await search.invoke(ctx, {
        session_id: s,
        query: "kafka ingestion",
        mode: "vector",
        limit: 10,
      }),
    );

    expect(before.some((r) => r.id === node.id)).toBe(false); // not embedded yet

    await worker.tick();

    const after = results(
      await search.invoke(ctx, {
        session_id: s,
        query: "kafka ingestion",
        mode: "vector",
        limit: 10,
      }),
    );

    const hit = after.find((r) => r.id === node.id)!;

    expect(hit.matched).toBe("vector");
    expect(typeof hit.best_chunk).toBe("string");
    expect(hit.best_chunk!.length).toBeGreaterThan(0);
  });

  it("mode:'text' is byte-compatible: envelopes only, no Phase-2 fields", async () => {
    const { ctx, worker } = makeCtx();
    const s = await session(ctx);
    await w(ctx, s, "semantic", "fact", "Alpha", "alpha beta gamma");
    await worker.tick();

    const res = await search.invoke(ctx, {
      session_id: s,
      query: "alpha",
      mode: "text",
      limit: 10,
    });

    expect(Object.keys(res).sort()).toEqual(["results", "total_matches"]);
    expect(res.context_notes).toBeUndefined();

    const env = (res.results as Record<string, unknown>[])[0]!;

    expect(Object.keys(env).sort()).toEqual([
      "edges",
      "id",
      "invalidated",
      "kind",
      "project",
      "rev",
      "summary",
      "title",
      "type",
      "updated",
    ]);
  });
});
