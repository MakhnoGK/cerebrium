import { describe, it, expect } from "vitest";
import { candidateHash } from "@/db/repositories/consolidation";
import { makeCtx } from "@test/helpers";

describe("ConsolidationRepo — candidate queue", () => {
  it("inserts a candidate and reads it back with parsed members + proposal", () => {
    const { repo } = makeCtx();
    const id = repo.insertCandidate({
      kind: "distill",
      project: "cerebrium",
      member_ids: ["b", "a", "c"],
      score: 0.9,
      proposal: { title: "T", summary: "S", body: "B" },
      detected_at: "2026-01-01T00:00:00.000Z",
    });
    expect(id).not.toBeNull();
    const c = repo.getCandidate(id!)!;
    expect(c.kind).toBe("distill");
    expect(c.status).toBe("pending");
    expect(c.member_ids).toEqual(["b", "a", "c"]);
    expect(c.proposal).toEqual({ title: "T", summary: "S", body: "B" });
    expect(c.canonical_id).toBeNull();
  });

  it("is idempotent by (kind, members) regardless of order — a duplicate is ignored", () => {
    const { repo } = makeCtx();
    const first = repo.insertCandidate({
      kind: "merge",
      member_ids: ["x", "y"],
      canonical_id: "x",
      score: 0.95,
      detected_at: "2026-01-01T00:00:00.000Z",
    });
    const dup = repo.insertCandidate({
      kind: "merge",
      member_ids: ["y", "x"], // reordered — same cluster
      canonical_id: "x",
      score: 0.99,
      detected_at: "2026-01-02T00:00:00.000Z",
    });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    expect(repo.pendingCandidates({ kind: "merge" })).toHaveLength(1);
    expect(repo.candidateExists("merge", ["x", "y"])).toBe(true);
    expect(candidateHash("merge", ["x", "y"])).toBe(candidateHash("merge", ["y", "x"]));
  });

  it("the same members under a different kind is a distinct candidate", () => {
    const { repo } = makeCtx();
    repo.insertCandidate({ kind: "link", member_ids: ["a", "b"], score: 0.9, detected_at: "t" });
    const other = repo.insertCandidate({
      kind: "merge",
      member_ids: ["a", "b"],
      score: 0.9,
      detected_at: "t",
    });
    expect(other).not.toBeNull();
  });

  it("pendingCandidates filters by status and orders by score desc", () => {
    const { repo } = makeCtx();
    const lo = repo.insertCandidate({
      kind: "distill",
      member_ids: ["a"],
      score: 0.5,
      detected_at: "t",
    })!;
    const hi = repo.insertCandidate({
      kind: "distill",
      member_ids: ["b"],
      score: 0.9,
      detected_at: "t",
    })!;
    const pending = repo.pendingCandidates();
    expect(pending.map((c) => c.id)).toEqual([hi, lo]);

    expect(repo.resolveCandidate(lo, "dismissed", "sess-1", "2026-01-03T00:00:00.000Z")).toBe(true);
    const after = repo.pendingCandidates();
    expect(after.map((c) => c.id)).toEqual([hi]);
    const resolved = repo.getCandidate(lo)!;
    expect(resolved.status).toBe("dismissed");
    expect(resolved.resolved_by).toBe("sess-1");
    expect(resolved.resolved_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("resolveCandidate is a no-op on an unknown or already-resolved candidate", () => {
    const { repo } = makeCtx();
    expect(repo.resolveCandidate("nope", "applied", "s", "t")).toBe(false);
    const id = repo.insertCandidate({
      kind: "prune",
      member_ids: ["m"],
      score: 1,
      detected_at: "t",
    })!;
    expect(repo.resolveCandidate(id, "applied", "s", "t")).toBe(true);
    expect(repo.resolveCandidate(id, "dismissed", "s2", "t2")).toBe(false); // already resolved
    expect(repo.getCandidate(id)!.status).toBe("applied");
  });
});
