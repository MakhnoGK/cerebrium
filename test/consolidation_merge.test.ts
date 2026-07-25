import { describe, it, expect, afterEach } from "vitest";
import { makeCtx } from "@test/helpers";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { ConsolidationProvider } from "@/consolidation/provider";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import type { EmbeddingWorker } from "@/embeddings/worker";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { LinkTool } from "../src/tools/link";
import { SearchTool } from "../src/tools/search";
import { ConsolidateApplyTool } from "../src/tools/consolidate_apply";

const session_start = new SessionStartTool();
const write = new WriteTool();
const link = new LinkTool();
const search = new SearchTool();
const consolidate_apply = new ConsolidateApplyTool();

const SHARED =
  "the payment service authorizes the card then captures the amount and emits a receipt event to the downstream ledger";

async function mk(ctx: Ctx, s: string, title: string, content: string): Promise<string> {
  return (
    (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title,
      content,
      project: "cerebrium",
    })) as Envelope
  ).id;
}

// Two near-identical semantic facts (cosine > 0.92) -> a merge candidate.
async function seedDupes(ctx: Ctx, worker: EmbeddingWorker) {
  const s = (await session_start.invoke(ctx, {})).session_id;
  const a = await mk(ctx, s, "Payments A", SHARED);
  const b = await mk(ctx, s, "Payments B", `${SHARED} duplicate`);
  await worker.tick();
  return { s, a, b };
}

const stubProvider: ConsolidationProvider = {
  name: "stub",
  version: "1",
  enabled: true,
  generate: () =>
    Promise.resolve({
      recommendation: "apply",
      reason: "same fact",
      title: "Merged payments",
      summary: "S",
      body: "merged body",
    }),
};

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_MERGE;
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
});

describe("semantic dedup / merge (P5 §8)", () => {
  it("suggest (default) queues a merge candidate with a chosen survivor", async () => {
    const { ctx, repo, worker } = makeCtx();
    const { a, b } = await seedDupes(ctx, worker);
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.merge_suggested).toBe(1);

    const [cand] = repo.pendingCandidates({ kind: "merge" });
    expect(cand!.member_ids).toEqual([a, b].sort());
    expect([a, b]).toContain(cand!.canonical_id);
  });

  it("accept supersedes the loser (kept in history) and re-points its authored edges", async () => {
    const { ctx, repo, worker } = makeCtx();
    const { s, a, b } = await seedDupes(ctx, worker);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    const [cand] = repo.pendingCandidates({ kind: "merge" });
    const survivor = cand!.canonical_id;
    const loser = [a, b].find((id) => id !== survivor)!;

    // give the loser an authored edge, then merge
    const third = await mk(ctx, s, "Ledger", "the ledger records settled transactions by day");
    await link.invoke(ctx, { session_id: s, src: loser, dst: third, type: "references" });

    const applied = (await consolidate_apply.invoke(ctx, {
      session_id: s,
      id: cand!.id,
      decision: "accept",
    })) as { status: string; kind: string };
    expect(applied).toMatchObject({ status: "applied", kind: "merge" });

    // loser hidden from normal search, present under history; survivor still valid
    const normal = (await search.invoke(ctx, {
      session_id: s,
      query: "payment card receipt ledger",
      limit: 10,
    })) as { results: Envelope[] };
    expect(normal.results.some((r) => r.id === loser)).toBe(false);
    expect(repo.envelope(survivor)!.invalidated).toBe(false);
    expect(repo.envelope(loser)!.invalidated).toBe(true);

    // the loser's references edge now hangs off the survivor
    expect(repo.edgesOf(survivor).some((e) => e.id === third && e.edge === "references")).toBe(
      true,
    );
    // supersedes survivor -> loser exists
    expect(repo.edgesOf(survivor).some((e) => e.id === loser && e.edge === "supersedes")).toBe(
      true,
    );
  });

  it("auto with a generating provider merges directly and rewrites the survivor", async () => {
    process.env.MEMORY_CONSOLIDATE_MERGE = "auto";
    const { ctx, repo, worker } = makeCtx({ consolidator: stubProvider });
    const { a, b } = await seedDupes(ctx, worker);

    const r = await new ConsolidationWorker(repo, stubProvider, ctx.now).tick();
    expect(r.merged).toBe(1);
    expect(repo.pendingCandidates({ kind: "merge" })).toHaveLength(0);

    const survivor = [a, b].find((id) => !repo.envelope(id)!.invalidated)!;
    const loser = [a, b].find((id) => repo.envelope(id)!.invalidated)!;
    expect(loser).toBeDefined();
    expect(repo.fullNode(survivor)!.content).toBe("merged body");
  });

  it("does not merge semantic nodes below the merge threshold", async () => {
    const { ctx, repo, worker } = makeCtx();
    const s = (await session_start.invoke(ctx, {})).session_id;
    await mk(ctx, s, "Alpha", "the payment service authorizes cards and captures amounts");
    await mk(ctx, s, "Beta", "kafka ingestion partitions events by tenant identifier daily");
    await worker.tick();
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.merge_suggested).toBe(0);
    expect(repo.pendingCandidates({ kind: "merge" })).toHaveLength(0);
  });
});
