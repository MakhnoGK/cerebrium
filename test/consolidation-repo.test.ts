import { describe, expect, it } from "vitest";
import { candidateHash } from "@/db/repositories/consolidation";
import { ConsolidationKind, ConsolidationStatus } from "@/core/vocab";
import { setup } from "@test/helpers";

describe("ConsolidationRepo candidate queue", () => {
  it("should insert a candidate and read it back with parsed members and proposal when a candidate is stored", () => {
    // Given
    const { consolidation } = setup();

    // When
    const id = consolidation.insertCandidate({
      kind: ConsolidationKind.DISTILL,
      project: "cerebrium",
      member_ids: ["b", "a", "c"],
      score: 0.9,
      proposal: { title: "T", summary: "S", body: "B" },
      detected_at: "2026-01-01T00:00:00.000Z",
    });

    // Then
    expect(id).not.toBeNull();
    const c = consolidation.getCandidate(id!)!;
    expect(c.kind).toBe("distill");
    expect(c.status).toBe("pending");
    expect(c.member_ids).toEqual(["b", "a", "c"]);
    expect(c.proposal).toEqual({ title: "T", summary: "S", body: "B" });
    expect(c.canonical_id).toBeNull();
  });

  it("should ignore a duplicate when the same (kind, members) cluster is inserted regardless of order", () => {
    // Given
    const { consolidation } = setup();

    // When
    const first = consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: ["x", "y"],
      canonical_id: "x",
      score: 0.95,
      detected_at: "2026-01-01T00:00:00.000Z",
    });
    const dup = consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: ["y", "x"], // reordered — same cluster
      canonical_id: "x",
      score: 0.99,
      detected_at: "2026-01-02T00:00:00.000Z",
    });

    // Then
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    expect(consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE })).toHaveLength(1);
    expect(consolidation.candidateExists(ConsolidationKind.MERGE, ["x", "y"])).toBe(true);
    expect(candidateHash(ConsolidationKind.MERGE, ["x", "y"])).toBe(
      candidateHash(ConsolidationKind.MERGE, ["y", "x"]),
    );
  });

  it("should create a distinct candidate when the same members are inserted under a different kind", () => {
    // Given
    const { consolidation } = setup();
    consolidation.insertCandidate({
      kind: ConsolidationKind.LINK,
      member_ids: ["a", "b"],
      score: 0.9,
      detected_at: "t",
    });

    // When
    const other = consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: ["a", "b"],
      score: 0.9,
      detected_at: "t",
    });

    // Then
    expect(other).not.toBeNull();
  });

  it("should filter by status and order by score descending when pending candidates are listed", () => {
    // Given
    const { consolidation } = setup();
    const lo = consolidation.insertCandidate({
      kind: ConsolidationKind.DISTILL,
      member_ids: ["a"],
      score: 0.5,
      detected_at: "t",
    })!;
    const hi = consolidation.insertCandidate({
      kind: ConsolidationKind.DISTILL,
      member_ids: ["b"],
      score: 0.9,
      detected_at: "t",
    })!;

    // When
    const pending = consolidation.pendingCandidates();

    // Then
    expect(pending.map((c) => c.id)).toEqual([hi, lo]);

    // When / Then
    expect(
      consolidation.resolveCandidate(
        lo,
        ConsolidationStatus.DISMISSED,
        "sess-1",
        "2026-01-03T00:00:00.000Z",
      ),
    ).toBe(true);
    const after = consolidation.pendingCandidates();
    expect(after.map((c) => c.id)).toEqual([hi]);
    const resolved = consolidation.getCandidate(lo)!;
    expect(resolved.status).toBe("dismissed");
    expect(resolved.resolved_by).toBe("sess-1");
    expect(resolved.resolved_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("should be a no-op when the candidate is unknown or already resolved", () => {
    // Given
    const { consolidation } = setup();

    // When / Then
    expect(consolidation.resolveCandidate("nope", ConsolidationStatus.APPLIED, "s", "t")).toBe(
      false,
    );

    // Given
    const id = consolidation.insertCandidate({
      kind: ConsolidationKind.PRUNE,
      member_ids: ["m"],
      score: 1,
      detected_at: "t",
    })!;

    // When / Then
    expect(consolidation.resolveCandidate(id, ConsolidationStatus.APPLIED, "s", "t")).toBe(true);
    expect(consolidation.resolveCandidate(id, ConsolidationStatus.DISMISSED, "s2", "t2")).toBe(
      false,
    ); // already resolved
    expect(consolidation.getCandidate(id)!.status).toBe("applied");
  });
});
