import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsolidationProvider } from "@/consolidation/provider";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { Envelope } from "@/db/repo";
import { _MemoryKind } from "@/core/vocab";
import { ConsolidateApplyTool } from "@/tools/consolidate-apply";
import { LinkTool } from "@/tools/link";
import { SearchTool } from "@/tools/search";
import { SessionStartTool } from "@/tools/session-start";
import { WriteTool } from "@/tools/write";
import { setup, TestEnv } from "@test/helpers";

const SHARED =
  "the payment service authorizes the card then captures the amount and emits a receipt event to the downstream ledger";

async function mk(s: string, title: string, content: string): Promise<string> {
  return (
    (await container.resolve(WriteTool).invoke({
      session_id: s,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content,
      project: "cerebrium",
    })) as Envelope
  ).id;
}

// Two near-identical semantic facts (cosine > 0.92) -> a merge candidate.
async function seedDupes(env: TestEnv) {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const a = await mk(s, "Payments A", SHARED);
  const b = await mk(s, "Payments B", `${SHARED} duplicate`);
  await env.worker.tick();
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
  reconcile: () => Promise.reject(new Error("not used")),
  annotate: () => Promise.reject(new Error("not used")),
};

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_MERGE;
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
});

describe("Semantic dedup / merge", () => {
  it("should queue a merge candidate with a chosen survivor under the default suggest posture", async () => {
    // Given
    const env = setup();
    const { a, b } = await seedDupes(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_suggested).toBe(1);
    const [cand] = env.consolidation.pendingCandidates({ kind: "merge" });
    expect(cand!.member_ids).toEqual([a, b].sort());
    expect([a, b]).toContain(cand!.canonical_id);
  });

  it("should supersede the loser (kept in history) and re-point its authored edges when accepted", async () => {
    // Given
    const env = setup();
    const { s, a, b } = await seedDupes(env);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = env.consolidation.pendingCandidates({ kind: "merge" });
    const survivor = cand!.canonical_id!;
    const loser = [a, b].find((id) => id !== survivor)!;

    // give the loser an authored edge, then merge
    const third = await mk(s, "Ledger", "the ledger records settled transactions by day");
    await container
      .resolve(LinkTool)
      .invoke({ session_id: s, src: loser, dst: third, type: "references" });

    // When
    const applied = (await container.resolve(ConsolidateApplyTool).invoke({
      session_id: s,
      id: cand!.id,
      decision: "accept",
    })) as { status: string; kind: string };

    // Then
    expect(applied).toMatchObject({ status: "applied", kind: "merge" });

    // loser hidden from normal search; survivor still valid.
    const normal = (await container.resolve(SearchTool).invoke({
      session_id: s,
      query: "payment card receipt ledger",
      limit: 10,
    })) as { results: Envelope[] };
    expect(normal.results.some((r) => r.id === loser)).toBe(false);
    expect(env.nodes.envelope(survivor)!.invalidated).toBe(false);
    expect(env.nodes.envelope(loser)!.invalidated).toBe(true);

    // the loser's references edge now hangs off the survivor, plus a supersedes edge.
    expect(env.edges.edgesOf(survivor).some((e) => e.id === third && e.edge === "references")).toBe(
      true,
    );
    expect(env.edges.edgesOf(survivor).some((e) => e.id === loser && e.edge === "supersedes")).toBe(
      true,
    );
  });

  it("should merge directly and rewrite the survivor when auto with a generating provider", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_MERGE = "auto";
    const env = setup({ consolidator: stubProvider });
    const { a, b } = await seedDupes(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merged).toBe(1);
    expect(env.consolidation.pendingCandidates({ kind: "merge" })).toHaveLength(0);
    const survivor = [a, b].find((id) => !env.nodes.envelope(id)!.invalidated)!;
    const loser = [a, b].find((id) => env.nodes.envelope(id)!.invalidated)!;
    expect(loser).toBeDefined();
    expect((await env.nodes.fullNode(survivor))!.content).toBe("merged body");
  });

  it("should not merge semantic nodes below the merge threshold", async () => {
    // Given
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await mk(s, "Alpha", "the payment service authorizes cards and captures amounts");
    await mk(s, "Beta", "kafka ingestion partitions events by tenant identifier daily");
    await env.worker.tick();

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_suggested).toBe(0);
    expect(env.consolidation.pendingCandidates({ kind: "merge" })).toHaveLength(0);
  });
});
