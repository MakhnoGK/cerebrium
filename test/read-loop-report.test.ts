import {
  fetchIndex,
  followThroughOf,
  pathCurve,
  rankCurve,
  splitOf,
  tally,
  type Fetch,
  type Surfacing,
} from "@scripts/read-loop-report";
import { describe, expect, it } from "vitest";

function search(over: Partial<Surfacing> = {}): Surfacing {
  return {
    action: "search",
    session: "S1",
    ts: "2026-08-09T10:00:00.000Z",
    ids: ["a", "b", "c"],
    matched: ["both", "vector", "graph"],
    ...over,
  };
}

function fetch(over: Partial<Fetch & { outline: boolean }> = {}): Fetch & { outline: boolean } {
  return {
    session: "S1",
    ts: "2026-08-09T10:01:00.000Z",
    ids: ["a"],
    outline: false,
    ...over,
  };
}

describe("fetchIndex", () => {
  it("should drop outline fetches, which are a decision aid rather than a read", () => {
    // Given
    const fetches = [fetch({ ids: ["a"] }), fetch({ ids: ["b"], outline: true })];

    // When
    const index = fetchIndex(fetches);

    // Then
    expect(index.get("S1")?.flatMap((entry) => entry.ids)).toEqual(["a"]);
  });
});

describe("followThroughOf", () => {
  it("should count a search as envelope-answered when nothing it surfaced was fetched", () => {
    // Given
    const searches = [search()];
    const index = fetchIndex([fetch({ ids: ["z"] })]);

    // When
    const result = followThroughOf(searches, index);

    // Then
    expect(result).toEqual({
      searches: 1,
      anyGet: 1,
      ownResultFetched: 0,
      envelopeOnly: 1,
    });
  });

  it("should not credit a fetch that happened before the search", () => {
    // Given
    const searches = [search({ ts: "2026-08-09T10:05:00.000Z" })];
    const index = fetchIndex([fetch({ ids: ["a"], ts: "2026-08-09T10:00:00.000Z" })]);

    // When
    const result = followThroughOf(searches, index);

    // Then
    expect(result.ownResultFetched).toBe(0);
  });

  it("should not credit a fetch from a different session", () => {
    // Given
    const searches = [search()];
    const index = fetchIndex([fetch({ ids: ["a"], session: "S2" })]);

    // When
    const result = followThroughOf(searches, index);

    // Then
    expect(result).toMatchObject({ anyGet: 0, ownResultFetched: 0 });
  });
});

describe("rankCurve", () => {
  it("should attribute a fetch to the rank the node was shown at", () => {
    // Given
    const searches = Array.from({ length: 5 }, () => search());
    const index = fetchIndex([fetch({ ids: ["b"] })]);

    // When
    const curve = rankCurve(searches, index);

    // Then
    expect(curve).toEqual([
      { rank: 0, shown: 5, fetched: 0 },
      { rank: 1, shown: 5, fetched: 5 },
      { rank: 2, shown: 5, fetched: 0 },
    ]);
  });

  it("should omit ranks with too few observations to read anything into", () => {
    // Given
    const searches = [search({ ids: ["a"], matched: ["text"] })];

    // When
    const curve = rankCurve(searches, fetchIndex([]));

    // Then
    expect(curve).toEqual([]);
  });
});

describe("pathCurve", () => {
  it("should attribute a fetch to the retrieval path that surfaced the node", () => {
    // Given
    const searches = [search()];
    const index = fetchIndex([fetch({ ids: ["c"] })]);

    // When
    const curve = pathCurve(searches, index);

    // Then
    expect(curve).toContainEqual({ matched: "graph", shown: 1, fetched: 1 });
    expect(curve).toContainEqual({ matched: "both", shown: 1, fetched: 0 });
  });

  it("should skip results from before the path was recorded", () => {
    // Given
    const searches = [search({ matched: [] })];

    // When
    const curve = pathCurve(searches, fetchIndex([]));

    // Then
    expect(curve).toEqual([]);
  });
});

describe("splitOf", () => {
  it("should separate never-surfaced from surfaced-but-unread", () => {
    // Given
    const surfaced = tally([search({ ids: ["a", "b"] })]);
    const fetched = tally([fetch({ ids: ["a"] })]);

    // When
    const split = splitOf("live", ["a", "b", "c"], surfaced, fetched);

    // Then
    expect(split).toEqual({
      label: "live",
      total: 3,
      neverSurfaced: 1,
      surfacedNotFetched: 1,
      fetched: 1,
    });
  });
});
