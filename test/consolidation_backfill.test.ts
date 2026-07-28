import { describe, it, expect } from "vitest";
import { container } from "tsyringe";
import { setup } from "@test/helpers";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { ConsolidationProvider } from "@/consolidation/provider";
import { _MemoryKind } from "@/core/vocab";
import type { Envelope } from "@/db/repo";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";

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

async function mk(s: string, title: string): Promise<string> {
  return (
    (await container.resolve(WriteTool).invoke({
      session_id: s,
      memory_kind: _MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: `content for ${title}`,
    })) as Envelope
  ).id;
}

describe("Proposal backfill (manual -> provider upgrade)", () => {
  it("should backfill a proposal for a proposal-less candidate when a generating provider is configured", async () => {
    // Given
    const env = setup({ consolidator: stub });
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const a = await mk(s, "Alpha");
    const b = await mk(s, "Beta");
    const id = env.consolidation.insertCandidate({
      kind: "merge",
      member_ids: [a, b],
      canonical_id: a,
      score: 0.95,
      detected_at: "2026-01-01T00:00:00.000Z",
    })!;
    expect(env.consolidation.getCandidate(id)!.proposal).toBeNull();

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.proposals_backfilled).toBe(1);
    expect(env.consolidation.getCandidate(id)!.proposal).toMatchObject({
      recommendation: "apply",
      title: "Drafted",
      summary: "S",
      body: "drafted body",
    });
  });

  it("should auto-dismiss a candidate and keep the reason when the provider judges it not a real duplicate", async () => {
    // Given
    const env = setup({ consolidator: rejectStub });
    const s = (await container.resolve(SessionStartTool).invoke({})).session_id;
    const a = await mk(s, "crm-backend deps");
    const b = await mk(s, "chat-socket deps");
    const id = env.consolidation.insertCandidate({
      kind: "merge",
      member_ids: [a, b],
      canonical_id: a,
      score: 0.93,
      detected_at: "2026-01-01T00:00:00.000Z",
    })!;

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.rejected).toBe(1);
    expect(r.proposals_backfilled).toBe(0);
    const cand = env.consolidation.getCandidate(id)!;
    expect(cand.status).toBe("dismissed"); // no longer clutters the Review inbox
    expect(cand.proposal?.recommendation).toBe("reject");
    expect(cand.proposal?.reason).toMatch(/different services/);
    expect(env.consolidation.pendingCandidates({ kind: "merge" })).toHaveLength(0);
  });

  it("should backfill nothing when the provider is the manual/disabled default", async () => {
    // Given
    const env = setup(); // default consolidator is manual (enabled=false)
    const id = env.consolidation.insertCandidate({
      kind: "distill",
      member_ids: ["x", "y", "z"],
      score: 0.9,
      detected_at: "2026-01-01T00:00:00.000Z",
    })!;

    // When
    const r = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(r.proposals_backfilled).toBe(0);
    expect(env.consolidation.getCandidate(id)!.proposal).toBeNull();
  });
});
