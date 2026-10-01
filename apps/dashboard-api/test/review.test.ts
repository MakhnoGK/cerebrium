import { describe, expect, it } from "vitest";
import type { KernelClient } from "@dashboard-api/kernel.client";
import { ReviewService } from "@dashboard-api/review.service";

function kernel(answers: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    sessionId: () => Promise.resolve("01M3W00000000000000000SESS"),
    call: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });

      return Promise.resolve(answers[name]);
    },
  } as unknown as KernelClient;

  return { client, calls };
}

const CANDIDATE = {
  id: "c1",
  kind: "merge",
  status: "pending",
  project: "cerebrium",
  member_ids: ["n1", "n2"],
  canonical_id: "n1",
  score: 0.95,
  proposal: null,
  detected_at: "2026-10-01T00:00:00.000Z",
  resolved_at: null,
  resolved_by: null,
  attempts: 0,
  last_error: null,
};

describe("Dashboard review", () => {
  it("should hand back each candidate with its members, marking the ones not found", async () => {
    // Given
    const { client, calls } = kernel({
      suggest_candidates: { candidates: [CANDIDATE], next_cursor: "next" },
      fetch_nodes: {
        nodes: [{ id: "n1", kind: "semantic", type: "fact", title: "One", content: "body" }],
      },
    });

    // When
    const page = await new ReviewService(client).candidates("merge");

    // Then
    expect(calls[0]).toEqual({
      name: "suggest_candidates",
      args: { page_size: 20, kind: "merge" },
    });
    expect(page.next_cursor).toBe("next");
    expect(page.candidates[0]!.members).toEqual([
      expect.objectContaining({ id: "n1", found: true, title: "One", content: "body" }),
      expect.objectContaining({ id: "n2", found: false, title: null }),
    ]);
  });

  it("should apply a merge as one node only when asked to collapse it", async () => {
    // Given
    const { client, calls } = kernel({ apply_candidate: { id: "c1", status: "applied" } });
    const review = new ReviewService(client);

    // When
    await review.decide("c1", { decision: "apply" });
    await review.decide("c1", { decision: "apply", collapse: true });

    // Then
    expect(calls.map((c) => c.args)).toEqual([
      { session_id: "01M3W00000000000000000SESS", id: "c1", decision: "apply" },
      { session_id: "01M3W00000000000000000SESS", id: "c1", decision: "apply", collapse: true },
    ]);
  });
});
