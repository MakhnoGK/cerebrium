import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsolidationRecommendation,
  type ConsolidationProvider,
} from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
import { ConsolidationKind, EdgeType, MemoryKind } from "@/core/vocab";
import { ConsolidateApplyTool } from "@/presentation/mcp/tools/consolidate-apply";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const SHARED =
  "the payment service authorizes the card then captures the amount and emits a receipt event to the downstream ledger";

async function mk(s: string, title: string, content: string): Promise<string> {
  return (
    (await container.resolve(WriteTool).invoke({
      session_id: s,
      parent_node_id: null,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content,
      project: "cerebrium",
    })) as Envelope
  ).id;
}

// Two near-identical semantic facts (cosine > 0.92) -> a merge candidate. The clock jumps
// past the burst window afterwards: written back to back by one session they would read as
// a series, which is a different test.
async function seedDupes(env: TestEnv) {
  const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
  const a = await mk(s, "Payments A", SHARED);
  const b = await mk(s, "Payments B", `${SHARED} duplicate`);
  await env.worker.tick();
  env.clock.advanceDays(1);
  return { s, a, b };
}

const stubProvider: ConsolidationProvider = {
  name: "stub",
  version: "1",
  enabled: true,
  generate: () =>
    Promise.resolve({
      recommendation: ConsolidationRecommendation.APPLY,
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
    const [cand] = env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    expect(cand!.member_ids).toEqual([a, b].sort());
    expect([a, b]).toContain(cand!.canonical_id);
  });

  it("should record duplicate_of and keep both nodes live when accepted", async () => {
    // Given
    const env = setup();
    const { s, a, b } = await seedDupes(env);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    const survivor = cand!.canonical_id!;
    const loser = [a, b].find((id) => id !== survivor)!;

    // When
    const applied = (await container.resolve(ConsolidateApplyTool).invoke({
      session_id: s,
      id: cand!.id,
      decision: ConsolidationRecommendation.APPLY,
    })) as { status: string };

    // Then
    expect(applied.status).toBe("applied");
    expect(env.nodes.envelope(survivor)!.invalidated).toBe(false);
    expect(env.nodes.envelope(loser)!.invalidated).toBe(false);
    expect(
      env.edges.edgesOf(loser).some((e) => e.id === survivor && e.edge === "duplicate_of"),
    ).toBe(true);
  });

  it("should supersede the loser (kept in history) and re-point its authored edges when collapsed", async () => {
    // Given
    const env = setup();
    const { s, a, b } = await seedDupes(env);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    const survivor = cand!.canonical_id!;
    const loser = [a, b].find((id) => id !== survivor)!;

    // give the loser an authored edge, then merge
    const third = await mk(s, "Ledger", "the ledger records settled transactions by day");
    await container
      .resolve(LinkTool)
      .invoke({ session_id: s, src: loser, dst: third, type: EdgeType.REFERENCES });

    // When
    const applied = (await container.resolve(ConsolidateApplyTool).invoke({
      session_id: s,
      id: cand!.id,
      decision: ConsolidationRecommendation.APPLY,
      collapse: true,
    })) as { status: string; kind: string };

    // Then
    expect(applied).toMatchObject({ status: "applied", kind: ConsolidationKind.MERGE });

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

  it("should record duplicate_of without destroying either node when auto", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_MERGE = "auto";
    const env = setup({ consolidator: stubProvider });
    const { a, b } = await seedDupes(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merged).toBe(1);
    expect(env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE })).toHaveLength(0);
    expect(env.nodes.envelope(a)!.invalidated).toBe(false);
    expect(env.nodes.envelope(b)!.invalidated).toBe(false);
    const recorded = [a, b].filter((id) =>
      env.edges.edgesOf(id).some((e) => e.edge === "duplicate_of"),
    );
    expect(recorded).toHaveLength(2);
  });

  it("should dismiss an overlapping collapse after its shared loser was already retired", async () => {
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const loser = await mk(s, "Shared loser", SHARED);
    const first = await mk(s, "First survivor", `${SHARED} first`);
    const second = await mk(s, "Second survivor", `${SHARED} second`);
    const firstCandidate = env.consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [first, loser],
      canonical_id: first,
      score: 0.99,
      detected_at: env.clock.t,
    })!;
    const secondCandidate = env.consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [second, loser],
      canonical_id: second,
      score: 0.98,
      detected_at: env.clock.t,
    })!;
    const apply = container.resolve(ConsolidateApplyTool);

    const firstResult = (await apply.invoke({
      session_id: s,
      id: firstCandidate,
      decision: ConsolidationRecommendation.APPLY,
      collapse: true,
    })) as { status: string };
    const secondResult = (await apply.invoke({
      session_id: s,
      id: secondCandidate,
      decision: ConsolidationRecommendation.APPLY,
      collapse: true,
    })) as { status: string };

    expect(firstResult.status).toBe("applied");
    expect(secondResult.status).toBe("dismissed");
    expect(env.nodes.envelope(loser)!.invalidated).toBe(true);
    expect(env.nodes.envelope(first)!.invalidated).toBe(false);
    expect(env.nodes.envelope(second)!.invalidated).toBe(false);
    expect(env.consolidation.getCandidate(secondCandidate)!.status).toBe("dismissed");
    expect(env.edges.edgesOf(second).some((e) => e.id === loser && e.edge === "supersedes")).toBe(
      false,
    );
  });

  it("should delay a pair one session wrote inside the burst window rather than proposing it", async () => {
    // Given
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await mk(s, "TI&H Module 1", SHARED);
    await mk(s, "TI&H Module 2", `${SHARED} duplicate`);
    await env.worker.tick();

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_delayed).toBe(1);
    expect(r.merge_suggested).toBe(0);
    expect(env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE })).toHaveLength(0);
  });

  it("should propose the same pair on a later sweep once it has aged out of the burst", async () => {
    // Given
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await mk(s, "TI&H Module 1", SHARED);
    await mk(s, "TI&H Module 2", `${SHARED} duplicate`);
    await env.worker.tick();
    await container.resolve(ConsolidationWorker).tick();

    // When
    env.clock.advanceDays(1);
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_delayed).toBe(0);
    expect(r.merge_suggested).toBe(1);
  });

  it("should not delay a pair two different sessions wrote at the same moment", async () => {
    // Given
    const env = setup();
    const first = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const second = (await container.resolve(SessionStartTool).invoke({})).session_id;
    await mk(first, "Payments A", SHARED);
    await mk(second, "Payments B", `${SHARED} duplicate`);
    await env.worker.tick();

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merge_delayed).toBe(0);
    expect(r.merge_suggested).toBe(1);
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
    expect(env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE })).toHaveLength(0);
  });
});
