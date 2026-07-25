import { describe, it, expect } from "vitest";
import { makeCtx } from "./helpers";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { ConsolidationProvider } from "@/consolidation/provider";
import type { Ctx } from "@/tools/context";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session_start";
import { WriteTool } from "../src/tools/write";

const session_start = new SessionStartTool();
const write = new WriteTool();

const stub: ConsolidationProvider = {
  name: "stub",
  version: "1",
  enabled: true,
  generate: () =>
    Promise.resolve({
      recommendation: "apply",
      reason: "same fact",
      title: "Drafted",
      summary: "S",
      body: "drafted body",
    }),
};

const rejectStub: ConsolidationProvider = {
  name: "reject-stub",
  version: "1",
  enabled: true,
  generate: () =>
    Promise.resolve({
      recommendation: "reject",
      reason: "different services, not a duplicate",
      title: "",
      summary: "",
      body: "",
    }),
};

async function mk(ctx: Ctx, s: string, title: string): Promise<string> {
  return (
    (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "semantic",
      type: "fact",
      title,
      content: `content for ${title}`,
    })) as Envelope
  ).id;
}

describe("proposal backfill (manual->provider upgrade)", () => {
  it("fills proposals for pending distill/merge candidates lacking them", async () => {
    const { ctx, repo } = makeCtx();
    const s = (await session_start.invoke(ctx, {})).session_id;
    const a = await mk(ctx, s, "Alpha");
    const b = await mk(ctx, s, "Beta");
    // a proposal-less merge candidate, as queued under the manual provider
    const id = repo.insertCandidate({
      kind: "merge",
      member_ids: [a, b],
      canonical_id: a,
      score: 0.95,
      detected_at: "2026-01-01T00:00:00.000Z",
    })!;
    expect(repo.getCandidate(id)!.proposal).toBeNull();

    const r = await new ConsolidationWorker(repo, stub, ctx.now).tick();
    expect(r.proposals_backfilled).toBe(1);
    expect(repo.getCandidate(id)!.proposal).toMatchObject({
      recommendation: "apply",
      title: "Drafted",
      summary: "S",
      body: "drafted body",
    });
  });

  it("auto-dismisses a candidate the provider judges not a real duplicate, keeping the reason", async () => {
    const { ctx, repo } = makeCtx();
    const s = (await session_start.invoke(ctx, {})).session_id;
    const a = await mk(ctx, s, "crm-backend deps");
    const b = await mk(ctx, s, "chat-socket deps");
    const id = repo.insertCandidate({
      kind: "merge",
      member_ids: [a, b],
      canonical_id: a,
      score: 0.93,
      detected_at: "2026-01-01T00:00:00.000Z",
    })!;

    const r = await new ConsolidationWorker(repo, rejectStub, ctx.now).tick();
    expect(r.rejected).toBe(1);
    expect(r.proposals_backfilled).toBe(0);
    const cand = repo.getCandidate(id)!;
    expect(cand.status).toBe("dismissed"); // no longer clutters the Review inbox
    expect(cand.proposal?.recommendation).toBe("reject");
    expect(cand.proposal?.reason).toMatch(/different services/);
    expect(repo.pendingCandidates({ kind: "merge" })).toHaveLength(0);
  });

  it("the manual/disabled provider backfills nothing (stays offline)", async () => {
    const { ctx, repo } = makeCtx(); // default consolidator is manual (enabled=false)
    const id = repo.insertCandidate({
      kind: "distill",
      member_ids: ["x", "y", "z"],
      score: 0.9,
      detected_at: "2026-01-01T00:00:00.000Z",
    })!;
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.proposals_backfilled).toBe(0);
    expect(repo.getCandidate(id)!.proposal).toBeNull();
  });
});
