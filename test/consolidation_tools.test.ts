import { describe, it, expect, afterEach } from "vitest";
import { makeCtx } from "@test/helpers";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import type { ConsolidationCandidate } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";
import { ConsolidateSuggestTool } from "../src/tools/consolidate_suggest";
import { ConsolidateApplyTool } from "../src/tools/consolidate_apply";

const session_start = new SessionStartTool();
const write = new WriteTool();
const consolidate_suggest = new ConsolidateSuggestTool();
const consolidate_apply = new ConsolidateApplyTool();

async function twinsWithSuggestedLink(
  ctx: Ctx,
  worker: {
    tick: () => Promise<{ embedded: number; failed: number }>;
  },
) {
  const s = (await session_start.invoke(ctx, {})).session_id;
  const dup = "circuit breaker opens after five consecutive downstream failures";
  const mk = async (title: string) =>
    (
      (await write.invoke(ctx, {
        session_id: s,
        memory_kind: "semantic",
        type: "fact",
        title,
        content: dup,
      })) as Envelope
    ).id;
  const a = await mk("Breaker A");
  const b = await mk("Breaker B");
  await worker.tick();
  return { s, a, b };
}

function candidates(res: unknown): ConsolidationCandidate[] {
  return (res as { candidates: ConsolidationCandidate[] }).candidates;
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
  delete process.env.MEMORY_CONSOLIDATE_MERGE;
});

describe("consolidate_suggest / consolidate_apply (P5 §9)", () => {
  it("suggest lists queued candidates; accept applies a link edge and resolves it", async () => {
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";
    process.env.MEMORY_CONSOLIDATE_MERGE = "off"; // isolate the link candidate
    const { ctx, repo, worker } = makeCtx();
    const { s, a, b } = await twinsWithSuggestedLink(ctx, worker);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();

    const listed = candidates(await consolidate_suggest.invoke(ctx, { session_id: s, limit: 20 }));
    expect(listed).toHaveLength(1);
    const cand = listed[0]!;
    expect(cand.kind).toBe("link");
    expect(cand.member_ids.sort()).toEqual([a, b].sort());

    const applied = (await consolidate_apply.invoke(ctx, {
      session_id: s,
      id: cand.id,
      decision: "accept",
    })) as { status: string; kind: string };
    expect(applied).toMatchObject({ status: "applied", kind: "link" });

    // the edge now exists and the candidate is no longer pending
    expect(repo.edgesOf(a).some((e) => e.id === b && e.edge === "similar_to")).toBe(true);
    expect(repo.pendingCandidates()).toHaveLength(0);
    expect(repo.getCandidate(cand.id)!.status).toBe("applied");
  });

  it("reject dismisses without writing an edge, and cannot be re-resolved", async () => {
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";
    process.env.MEMORY_CONSOLIDATE_MERGE = "off"; // isolate the link candidate
    const { ctx, repo, worker } = makeCtx();
    const { s, a, b } = await twinsWithSuggestedLink(ctx, worker);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    const cand = candidates(await consolidate_suggest.invoke(ctx, { session_id: s }))[0]!;

    const rejected = (await consolidate_apply.invoke(ctx, {
      session_id: s,
      id: cand.id,
      decision: "reject",
    })) as { status: string };
    expect(rejected.status).toBe("dismissed");
    expect(repo.edgesOf(a).some((e) => e.id === b && e.edge === "similar_to")).toBe(false);

    await expect(
      consolidate_apply.invoke(ctx, { session_id: s, id: cand.id, decision: "accept" }),
    ).rejects.toThrow(/already dismissed/);
  });

  it("errors on an unknown candidate id", async () => {
    const { ctx } = makeCtx();
    const s = (await session_start.invoke(ctx, {})).session_id;
    await expect(
      consolidate_apply.invoke(ctx, { session_id: s, id: "nope", decision: "accept" }),
    ).rejects.toThrow(/no consolidation candidate/);
  });

  it("suggest returns an empty list when nothing is queued", async () => {
    const { ctx } = makeCtx();
    const s = (await session_start.invoke(ctx, {})).session_id;
    expect(candidates(await consolidate_suggest.invoke(ctx, { session_id: s }))).toEqual([]);
  });
});
