import { describe, it, expect, afterEach } from "vitest";
import { makeCtx } from "./helpers";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { ConsolidationProvider } from "@/consolidation/provider";
import type { Ctx } from "@/tools/context";
import type { EmbeddingWorker } from "@/embeddings/worker";
import { WriteTool } from "../src/tools/write";
import { SessionStartTool } from "../src/tools/session_start";
import { ConsolidateApplyTool } from "../src/tools/consolidate_apply";

const session_start = new SessionStartTool();
const write = new WriteTool();
const consolidate_apply = new ConsolidateApplyTool();

const BASE = "the deployment rollback procedure drains connections and flips the feature flag";

// Three near-identical episodics (one distinct token each) → tight cluster, distinct nodes.
async function seedEpisodics(
  ctx: Ctx,
  worker: EmbeddingWorker,
  n = 3,
): Promise<{ s: string; ids: string[] }> {
  const s = (await session_start.invoke(ctx, {})).session_id;
  const ids: string[] = [];
  const tags = ["one", "two", "three", "four"];
  for (let i = 0; i < n; i++) {
    const env = (await write.invoke(ctx, {
      session_id: s,
      memory_kind: "episodic",
      type: "event_note",
      title: `Rollback ${tags[i]!}`,
      content: `${BASE} ${tags[i]!}`,
      project: "cerebrium",
    })) as { id: string };
    ids.push(env.id);
  }
  await worker.tick(); // embed so the cluster detector has vectors
  return { s, ids };
}

const stubProvider: ConsolidationProvider = {
  name: "stub",
  version: "1",
  enabled: true,
  generate: () =>
    Promise.resolve({
      recommendation: "apply",
      reason: "same procedure",
      title: "Rollback procedure",
      summary: "S",
      body: "B body",
    }),
};

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_DISTILL;
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
});

describe("episodic → semantic distillation (P5 §6)", () => {
  it("suggest (default, manual) queues a distill candidate with no proposal", async () => {
    const { ctx, repo, worker, clock } = makeCtx();
    const { ids } = await seedEpisodics(ctx, worker);
    clock.advanceDays(15); // age past the 14-day floor

    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.distill_suggested).toBe(1);
    expect(r.distilled).toBe(0);

    const [cand] = repo.pendingCandidates({ kind: "distill" });
    expect(cand).toBeDefined();
    expect(cand!.member_ids).toEqual([...ids].sort());
    expect(cand!.proposal).toBeNull();
  });

  it("accept with an override writes a fact, links derived_from, and stamps sources", async () => {
    const { ctx, repo, worker, clock, db } = makeCtx();
    const { s, ids } = await seedEpisodics(ctx, worker);
    clock.advanceDays(15);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    const [cand] = repo.pendingCandidates({ kind: "distill" });

    const applied = (await consolidate_apply.invoke(ctx, {
      session_id: s,
      id: cand!.id,
      decision: "accept",
      override: { title: "Rollback runbook", summary: "one-liner", body: "the durable fact body" },
    })) as { status: string; kind: string };
    expect(applied).toMatchObject({ status: "applied", kind: "distill" });

    // a new semantic fact exists, derived_from each source
    const fact = db
      .prepare("SELECT id FROM nodes WHERE memory_kind = 'semantic' AND title = ?")
      .get("Rollback runbook") as { id: string } | undefined;
    expect(fact).toBeDefined();
    const derived = repo
      .edgesOf(fact!.id)
      .filter((e) => e.edge === "derived_from")
      .map((e) => e.id)
      .sort();
    expect(derived).toEqual([...ids].sort());

    // every source is stamped consolidated_at and the candidate is applied
    for (const id of ids) {
      const row = db.prepare("SELECT consolidated_at FROM nodes WHERE id = ?").get(id) as {
        consolidated_at: string | null;
      };
      expect(row.consolidated_at).not.toBeNull();
    }
    expect(repo.getCandidate(cand!.id)!.status).toBe("applied");
  });

  it("accepting a proposal-less candidate without an override errors", async () => {
    const { ctx, repo, worker, clock } = makeCtx();
    const { s } = await seedEpisodics(ctx, worker);
    clock.advanceDays(15);
    await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    const [cand] = repo.pendingCandidates({ kind: "distill" });

    await expect(
      consolidate_apply.invoke(ctx, { session_id: s, id: cand!.id, decision: "accept" }),
    ).rejects.toThrow(/no proposal/);
  });

  it("does not distill episodics younger than the age floor", async () => {
    const { ctx, repo, worker } = makeCtx();
    await seedEpisodics(ctx, worker); // no clock advance → too young
    const r = await new ConsolidationWorker(repo, ctx.consolidator, ctx.now).tick();
    expect(r.distill_suggested).toBe(0);
    expect(repo.pendingCandidates({ kind: "distill" })).toHaveLength(0);
  });

  it("auto with a generating provider writes the fact directly, idempotently", async () => {
    process.env.MEMORY_CONSOLIDATE_DISTILL = "auto";
    const { ctx, repo, worker, clock, db } = makeCtx({ consolidator: stubProvider });
    const { ids } = await seedEpisodics(ctx, worker);
    clock.advanceDays(15);

    const cw = new ConsolidationWorker(repo, stubProvider, ctx.now);
    const r = await cw.tick();
    expect(r.distilled).toBe(1);
    expect(r.distill_suggested).toBe(0);
    expect(repo.pendingCandidates({ kind: "distill" })).toHaveLength(0);

    const fact = db
      .prepare("SELECT id FROM nodes WHERE memory_kind = 'semantic' AND title = ?")
      .get("Rollback procedure") as { id: string } | undefined;
    expect(fact).toBeDefined();
    for (const id of ids) {
      const row = db.prepare("SELECT consolidated_at FROM nodes WHERE id = ?").get(id) as {
        consolidated_at: string | null;
      };
      expect(row.consolidated_at).not.toBeNull();
    }

    // second sweep: sources are consolidated, so nothing re-distills
    expect((await cw.tick()).distilled).toBe(0);
  });
});
