import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { ConsolidationKind, EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  ConsolidationRecommendation,
  type ConsolidationProvider,
  type ConsolidationResult,
  type ConsolidationTask,
} from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
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
      missing: [],
    }),
  reconcile: () => Promise.reject(new Error("not used")),
  annotate: () => Promise.reject(new Error("not used")),
  relate: () => Promise.reject(new Error("not used")),
  resolveLink: () => Promise.reject(new Error("not used")),
};

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_MERGE;
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
  delete process.env.MEMORY_CONSOLIDATE_PROTECT_INBOUND;
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
    const [cand] = await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    expect(cand!.member_ids).toEqual([a, b].sort());
    expect([a, b]).toContain(cand!.canonical_id);
  });

  it("should record duplicate_of and keep both nodes live when accepted", async () => {
    // Given
    const env = setup();
    const { s, a, b } = await seedDupes(env);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
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
    expect((await env.nodes.envelope(survivor))!.invalidated).toBe(false);
    expect((await env.nodes.envelope(loser))!.invalidated).toBe(false);
    expect(
      (await env.edges.edgesOf(loser)).some((e) => e.id === survivor && e.edge === "duplicate_of"),
    ).toBe(true);
  });

  it("should supersede the loser (kept in history) and re-point its authored edges when collapsed", async () => {
    // Given
    const env = setup();
    const { s, a, b } = await seedDupes(env);
    await container.resolve(ConsolidationWorker).tick();
    const [cand] = await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
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
    expect((await env.nodes.envelope(survivor))!.invalidated).toBe(false);
    expect((await env.nodes.envelope(loser))!.invalidated).toBe(true);

    // the loser's references edge now hangs off the survivor, plus a supersedes edge.
    expect(
      (await env.edges.edgesOf(survivor)).some((e) => e.id === third && e.edge === "references"),
    ).toBe(true);
    expect(
      (await env.edges.edgesOf(survivor)).some((e) => e.id === loser && e.edge === "supersedes"),
    ).toBe(true);
  });

  it("should collapse the pair into the survivor and record an applied candidate when auto", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_MERGE = "auto";
    const env = setup({ consolidator: stubProvider });
    const { a, b } = await seedDupes(env);

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merged).toBe(1);
    expect(
      await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE }),
    ).toHaveLength(0);
    expect(await env.consolidation.candidateExists(ConsolidationKind.MERGE, [a, b])).toBe(true);
    const envelopes = [(await env.nodes.envelope(a))!, (await env.nodes.envelope(b))!];
    const survivors = envelopes.filter((e) => !e.invalidated);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.title).toBe("Merged payments");
  });

  it("should leave a hand-maintained pair queued when auto", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_MERGE = "auto";
    process.env.MEMORY_CONSOLIDATE_PROTECT_INBOUND = "1";
    const env = setup({ consolidator: stubProvider });
    const { s, a, b } = await seedDupes(env);
    const citing = await mk(s, "Ledger", "the ledger records settled transactions by day");
    for (const dst of [a, b]) {
      await container
        .resolve(LinkTool)
        .invoke({ session_id: s, src: citing, dst, type: EdgeType.REFERENCES });
    }

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.merged).toBe(0);
    expect(r.merge_suggested).toBe(1);
    expect((await env.nodes.envelope(a))!.invalidated).toBe(false);
    expect((await env.nodes.envelope(b))!.invalidated).toBe(false);
  });

  it("should dismiss an overlapping collapse after its shared loser was already retired", async () => {
    const env = setup();
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const loser = await mk(s, "Shared loser", SHARED);
    const first = await mk(s, "First survivor", `${SHARED} first`);
    const second = await mk(s, "Second survivor", `${SHARED} second`);
    const firstCandidate = (await env.consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [first, loser],
      canonical_id: first,
      score: 0.99,
      detected_at: env.clock.t,
    }))!;
    const secondCandidate = (await env.consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [second, loser],
      canonical_id: second,
      score: 0.98,
      detected_at: env.clock.t,
    }))!;
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
    expect((await env.nodes.envelope(loser))!.invalidated).toBe(true);
    expect((await env.nodes.envelope(first))!.invalidated).toBe(false);
    expect((await env.nodes.envelope(second))!.invalidated).toBe(false);
    expect((await env.consolidation.getCandidate(secondCandidate))!.status).toBe("dismissed");
    expect(
      (await env.edges.edgesOf(second)).some((e) => e.id === loser && e.edge === "supersedes"),
    ).toBe(false);
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
    expect(
      await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE }),
    ).toHaveLength(0);
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
    expect(
      await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE }),
    ).toHaveLength(0);
  });
});

function draftingProvider(drafts: Pick<ConsolidationResult, "body" | "missing">[]) {
  const tasks: ConsolidationTask[] = [];
  const provider: ConsolidationProvider = {
    ...stubProvider,
    generate: (task) => {
      tasks.push(task);
      const draft = drafts[Math.min(tasks.length - 1, drafts.length - 1)]!;

      return Promise.resolve({
        recommendation: ConsolidationRecommendation.APPLY,
        reason: "same fact",
        title: "Payments",
        summary: "S",
        ...draft,
      });
    },
  };

  return { provider, tasks };
}

describe("Merge drafts that lose anchors", () => {
  it("should ask once more with the lost anchors and keep the draft that loses fewer", async () => {
    // Given
    const { provider, tasks } = draftingProvider([
      { body: "first", missing: ["01ABC", "deploy.sh"] },
      { body: "second", missing: ["deploy.sh"] },
    ]);
    const env = setup({ consolidator: provider });
    await seedDupes(env);

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then
    const [cand] = await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    expect(tasks.map((t) => t.missing)).toEqual([undefined, ["01ABC", "deploy.sh"]]);
    expect(tasks[0]!.canonical_id).toBe(cand!.canonical_id);
    expect(cand!.proposal).toMatchObject({ body: "second", missing: ["deploy.sh"] });
  });

  it("should keep the first draft when the second loses as much", async () => {
    // Given
    const { provider, tasks } = draftingProvider([
      { body: "first", missing: ["01ABC"] },
      { body: "second", missing: ["01ABC"] },
    ]);
    const env = setup({ consolidator: provider });
    await seedDupes(env);

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then
    const [cand] = await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    expect(tasks).toHaveLength(2);
    expect(cand!.proposal).toMatchObject({ body: "first", missing: ["01ABC"] });
  });

  it("should not ask again when the draft loses nothing", async () => {
    // Given
    const { provider, tasks } = draftingProvider([{ body: "whole", missing: [] }]);
    const env = setup({ consolidator: provider });
    await seedDupes(env);

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(tasks).toHaveLength(1);
  });
});
