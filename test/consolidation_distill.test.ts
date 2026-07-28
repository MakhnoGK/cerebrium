import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsolidationProvider } from "@/consolidation/provider";
import { ConsolidationWorker } from "@/consolidation/worker";
import { _MemoryKind } from "@/core/vocab";
import { ConsolidateApplyTool } from "@/tools/consolidate-apply";
import { SessionStartTool } from "@/tools/session-start";
import { WriteTool } from "@/tools/write";
import { setup, TestEnv } from "@test/helpers";

const BASE = "the deployment rollback procedure drains connections and flips the feature flag";

// Three near-identical episodics (one distinct token each) -> tight cluster, distinct nodes.
async function seedEpisodics(env: TestEnv, n = 3): Promise<{ s: string; ids: string[] }> {
  const write = container.resolve(WriteTool);
  const sessionStart = container.resolve(SessionStartTool);
  const s = (await sessionStart.invoke({})).session_id;
  const ids: string[] = [];
  const tags = ["one", "two", "three", "four"];
  for (let i = 0; i < n; i++) {
    const node = (await write.invoke({
      session_id: s,
      memory_kind: _MemoryKind.EPISODIC,
      type: "event_note",
      title: `Rollback ${tags[i]!}`,
      content: `${BASE} ${tags[i]!}`,
      project: "cerebrium",
    })) as { id: string };
    ids.push(node.id);
  }
  await env.worker.tick(); // embed so the cluster detector has vectors
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
  reconcile: () => Promise.reject(new Error("not used")),
  annotate: () => Promise.reject(new Error("not used")),
};

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_DISTILL;
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
});

describe("Episodic -> semantic distillation", () => {
  it("should queue a distill candidate with no proposal when the posture is the default suggest", async () => {
    // Given
    const env = setup();
    const { ids } = await seedEpisodics(env);
    env.clock.advanceDays(15); // age past the 14-day floor

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.distill_suggested).toBe(1);
    expect(r.distilled).toBe(0);
    const [cand] = env.consolidation.pendingCandidates({ kind: "distill" });
    expect(cand).toBeDefined();
    expect(cand!.member_ids).toEqual([...ids].sort());
    expect(cand!.proposal).toBeNull();
  });

  it("should write a fact, link derived_from, and stamp sources when an override is accepted", async () => {
    // Given
    const env = setup();
    const { s, ids } = await seedEpisodics(env);
    env.clock.advanceDays(15);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = env.consolidation.pendingCandidates({ kind: "distill" });

    // When
    const applied = (await container.resolve(ConsolidateApplyTool).invoke({
      session_id: s,
      id: cand!.id,
      decision: "accept",
      override: { title: "Rollback runbook", summary: "one-liner", body: "the durable fact body" },
    })) as { status: string; kind: string };

    // Then
    expect(applied).toMatchObject({ status: "applied", kind: "distill" });

    // a new semantic fact exists, derived_from each source
    const fact = env.db
      .prepare("SELECT id FROM nodes WHERE memory_kind = 'semantic' AND title = ?")
      .get("Rollback runbook") as { id: string } | undefined;
    expect(fact).toBeDefined();
    const derived = env.edges
      .edgesOf(fact!.id)
      .filter((e) => e.edge === "derived_from")
      .map((e) => e.id)
      .sort();
    expect(derived).toEqual([...ids].sort());

    // every source is stamped consolidated_at and the candidate is applied
    for (const id of ids) {
      const row = env.db.prepare("SELECT consolidated_at FROM nodes WHERE id = ?").get(id) as {
        consolidated_at: string | null;
      };
      expect(row.consolidated_at).not.toBeNull();
    }
    expect(env.consolidation.getCandidate(cand!.id)!.status).toBe("applied");
  });

  it("should throw when a proposal-less candidate is accepted without an override", async () => {
    // Given
    const env = setup();
    const { s } = await seedEpisodics(env);
    env.clock.advanceDays(15);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = env.consolidation.pendingCandidates({ kind: "distill" });

    // When / Then
    await expect(
      container
        .resolve(ConsolidateApplyTool)
        .invoke({ session_id: s, id: cand!.id, decision: "accept" }),
    ).rejects.toThrow(/no proposal/);
  });

  it("should not distill episodics that are younger than the age floor", async () => {
    // Given
    const env = setup();
    await seedEpisodics(env); // no clock advance -> too young

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.distill_suggested).toBe(0);
    expect(env.consolidation.pendingCandidates({ kind: "distill" })).toHaveLength(0);
  });

  it("should write the fact directly and idempotently when auto with a generating provider", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_DISTILL = "auto";
    const env = setup({ consolidator: stubProvider });
    const { ids } = await seedEpisodics(env);
    env.clock.advanceDays(15);
    const cw = container.resolve(ConsolidationWorker);

    // When
    const r = await cw.tick();

    // Then
    expect(r.distilled).toBe(1);
    expect(r.distill_suggested).toBe(0);
    expect(env.consolidation.pendingCandidates({ kind: "distill" })).toHaveLength(0);

    const fact = env.db
      .prepare("SELECT id FROM nodes WHERE memory_kind = 'semantic' AND title = ?")
      .get("Rollback procedure") as { id: string } | undefined;
    expect(fact).toBeDefined();
    for (const id of ids) {
      const row = env.db.prepare("SELECT consolidated_at FROM nodes WHERE id = ?").get(id) as {
        consolidated_at: string | null;
      };
      expect(row.consolidated_at).not.toBeNull();
    }

    // When / Then — second sweep: sources are consolidated, so nothing re-distills.
    expect((await cw.tick()).distilled).toBe(0);
  });
});
