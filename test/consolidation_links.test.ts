import { describe, it, expect, afterEach } from "vitest";
import { makeCtx } from "./helpers";
import * as session_start from "@/tools/session_start";
import * as write from "@/tools/write";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import type { EmbeddingWorker } from "@/embeddings/worker";

async function newNode(ctx: Ctx, s: string, title: string, content: string): Promise<string> {
  return (
    (await write.handler(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title,
      content,
    })) as Envelope
  ).id;
}

async function newEpisodic(ctx: Ctx, s: string, title: string, content: string): Promise<string> {
  return (
    (await write.handler(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "event_note",
      title,
      content,
    })) as Envelope
  ).id;
}

async function seed(ctx: Ctx, worker: EmbeddingWorker) {
  const s = (await session_start.handler(ctx, {})).session_id;
  // Two nodes with identical content → identical local-null vectors (cosine 1.0);
  // a third, disjoint node stays unlinked.
  const dup = "the http client retries three times with exponential backoff";
  const twinA = await newNode(ctx, s, "Retry budget", dup);
  const twinB = await newNode(ctx, s, "Client retries", dup);
  const other = await newNode(ctx, s, "Kafka", "ingestion consumes kafka topics by tenant");
  await worker.tick(); // embed all three so the kNN detector has vectors
  return { s, twinA, twinB, other };
}

function edgeTypesBetween(ctx: Ctx, a: string, b: string): string[] {
  return ctx.repo
    .edgesOf(a)
    .filter((e) => e.id === b)
    .map((e) => e.edge);
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
  delete process.env.MEMORY_CONSOLIDATE_SIM;
});

describe("similar_to link discovery (P5 §7)", () => {
  it("auto (default) writes a system similar_to edge between near-identical nodes only", async () => {
    const { ctx, repo, worker } = makeCtx();
    const { twinA, twinB, other } = await seed(ctx, worker);

    const cw = new ConsolidationWorker(repo, ctx.consolidator, ctx.now);
    const r = await cw.tick();
    expect(r.links_added).toBe(1);

    expect(edgeTypesBetween(ctx, twinA, twinB)).toContain("similar_to");
    expect(edgeTypesBetween(ctx, twinA, other)).not.toContain("similar_to");
  });

  it("is idempotent — a second sweep adds no duplicate edge", async () => {
    const { ctx, repo, worker } = makeCtx();
    await seed(ctx, worker);
    const cw = new ConsolidationWorker(repo, ctx.consolidator, ctx.now);
    expect((await cw.tick()).links_added).toBe(1);
    expect((await cw.tick()).links_added).toBe(0);
  });

  it("writes a system-provenance edge that graph expansion can traverse", async () => {
    const { ctx, repo, worker } = makeCtx();
    const { twinA, twinB } = await seed(ctx, worker);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();

    // neighborsOf is what search uses for 1-hop graph expansion: the discovered
    // similar_to edge makes each twin a neighbor of the other.
    const neighbors = repo.neighborsOf([twinA]);
    const hit = neighbors.find((n) => n.node.id === twinB);
    expect(hit).toBeDefined();
    expect(hit!.edge).toBe("similar_to");
  });

  it("suggest posture queues a link candidate instead of writing an edge", async () => {
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";
    const { ctx, repo, worker } = makeCtx();
    const { twinA, twinB } = await seed(ctx, worker);

    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.links_suggested).toBe(1);
    expect(r.links_added).toBe(0);
    expect(edgeTypesBetween(ctx, twinA, twinB)).not.toContain("similar_to");
    const pending = repo.pendingCandidates({ kind: "link" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.member_ids.sort()).toEqual([twinA, twinB].sort());
  });

  it("off posture does nothing", async () => {
    process.env.MEMORY_CONSOLIDATE_LINKS = "off";
    const { ctx, repo, worker } = makeCtx();
    await seed(ctx, worker);
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r).toMatchObject({ links_added: 0, links_suggested: 0 });
  });
});

describe("orphan episodic repair — link discovery reconnects unlinked episodics", () => {
  it("links an unlinked episodic to its nearest semantic neighbor", async () => {
    const { ctx, repo, worker } = makeCtx();
    const s = (await session_start.handler(ctx, {})).session_id;
    const topic = "the http client retries three times with exponential backoff";
    const fact = await newNode(ctx, s, "Retry budget", topic);
    const orphan = await newEpisodic(ctx, s, "Touched the retry logic", topic);
    await worker.tick();

    // A checkpoint/event_note written without touched_node_ids has no edges at all.
    expect(repo.edgesOf(orphan)).toHaveLength(0);

    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.links_added).toBe(1);
    expect(edgeTypesBetween(ctx, orphan, fact)).toContain("similar_to");
  });

  it("re-seeds nothing once the episodic has an edge (idempotent)", async () => {
    const { ctx, repo, worker } = makeCtx();
    const s = (await session_start.handler(ctx, {})).session_id;
    const topic = "the http client retries three times with exponential backoff";
    await newNode(ctx, s, "Retry budget", topic);
    await newEpisodic(ctx, s, "Touched the retry logic", topic);
    await worker.tick();

    const cw = new ConsolidationWorker(repo, ctx.consolidator, ctx.now);
    expect((await cw.tick()).links_added).toBe(1);
    expect((await cw.tick()).links_added).toBe(0);
  });
});
