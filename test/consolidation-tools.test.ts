import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { ConsolidationRecommendation } from "@/domain/ports/consolidation-provider";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { ConsolidationCandidate, Envelope } from "@/db/repo";
import { ConsolidationKind, MemoryKind } from "@/core/vocab";
import { ConsolidateApplyTool } from "@/tools/consolidate-apply";
import { ConsolidateSuggestTool } from "@/tools/consolidate-suggest";
import { SessionStartTool } from "@/tools/session-start";
import { WriteTool } from "@/tools/write";
import { setup, TestEnv } from "@test/helpers";

function tools() {
  return {
    sessionStart: container.resolve(SessionStartTool),
    write: container.resolve(WriteTool),
    consolidateSuggest: container.resolve(ConsolidateSuggestTool),
    consolidateApply: container.resolve(ConsolidateApplyTool),
  };
}

async function twinsWithSuggestedLink(env: TestEnv, t: ReturnType<typeof tools>) {
  const s = (await t.sessionStart.invoke({})).session_id;
  const dup = "circuit breaker opens after five consecutive downstream failures";
  const mk = async (title: string) =>
    (
      (await t.write.invoke({
        session_id: s,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title,
        content: dup,
      })) as Envelope
    ).id;
  const a = await mk("Breaker A");
  const b = await mk("Breaker B");
  await env.worker.tick();
  return { s, a, b };
}

function candidates(res: unknown): ConsolidationCandidate[] {
  return (res as { candidates: ConsolidationCandidate[] }).candidates;
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
  delete process.env.MEMORY_CONSOLIDATE_MERGE;
});

describe("ConsolidateSuggestTool / ConsolidateApplyTool", () => {
  it("should list a queued link candidate and apply a similar_to edge when accepted", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";
    process.env.MEMORY_CONSOLIDATE_MERGE = "off"; // isolate the link candidate
    const env = setup();
    const t = tools();
    const { s, a, b } = await twinsWithSuggestedLink(env, t);
    await container.resolve(ConsolidationWorker).tick();

    // When
    const listed = candidates(await t.consolidateSuggest.invoke({ session_id: s, limit: 20 }));

    // Then
    expect(listed).toHaveLength(1);
    const cand = listed[0]!;
    expect(cand.kind).toBe("link");
    expect(cand.member_ids.sort()).toEqual([a, b].sort());

    // When
    const applied = (await t.consolidateApply.invoke({
      session_id: s,
      id: cand.id,
      decision: ConsolidationRecommendation.APPLY,
    })) as { status: string; kind: string };

    // Then — the edge now exists and the candidate is no longer pending.
    expect(applied).toMatchObject({ status: "applied", kind: ConsolidationKind.LINK });
    expect(env.edges.edgesOf(a).some((e) => e.id === b && e.edge === "similar_to")).toBe(true);
    expect(env.consolidation.pendingCandidates()).toHaveLength(0);
    expect(env.consolidation.getCandidate(cand.id)!.status).toBe("applied");
  });

  it("should dismiss without an edge and refuse re-resolution when rejected", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";
    process.env.MEMORY_CONSOLIDATE_MERGE = "off"; // isolate the link candidate
    const env = setup();
    const t = tools();
    const { s, a, b } = await twinsWithSuggestedLink(env, t);
    await container.resolve(ConsolidationWorker).tick();
    const cand = candidates(await t.consolidateSuggest.invoke({ session_id: s }))[0]!;

    // When
    const rejected = (await t.consolidateApply.invoke({
      session_id: s,
      id: cand.id,
      decision: ConsolidationRecommendation.REJECT,
    })) as { status: string };

    // Then
    expect(rejected.status).toBe("dismissed");
    expect(env.edges.edgesOf(a).some((e) => e.id === b && e.edge === "similar_to")).toBe(false);

    // When / Then — a dismissed candidate cannot be re-resolved.
    await expect(
      t.consolidateApply.invoke({
        session_id: s,
        id: cand.id,
        decision: ConsolidationRecommendation.APPLY,
      }),
    ).rejects.toThrow(/already dismissed/);
  });

  it("should throw when the candidate id is unknown", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When / Then
    await expect(
      t.consolidateApply.invoke({
        session_id: s,
        id: "nope",
        decision: ConsolidationRecommendation.APPLY,
      }),
    ).rejects.toThrow(/no consolidation candidate/);
  });

  it("should return an empty list when nothing is queued", async () => {
    // Given
    setup();
    const t = tools();
    const s = (await t.sessionStart.invoke({})).session_id;

    // When / Then
    expect(candidates(await t.consolidateSuggest.invoke({ session_id: s }))).toEqual([]);
  });
});
