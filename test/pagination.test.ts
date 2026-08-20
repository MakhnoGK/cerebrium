import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidCursorError } from "@/application/errors";
import {
  SUGGEST_CANDIDATES,
  type SuggestCandidates,
  type SuggestCandidatesResult,
} from "@/application/use-cases";
import { newId } from "@/core/ids";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
  pageSizeOf,
  splitOverfetch,
} from "@/core/page";
import { ConsolidationKind } from "@/core/vocab";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

// Candidates are inserted directly: the detection path is not what these tests are about,
// and it cannot produce a controlled score/timestamp ladder.
function candidate(score: number, detectedAt: string, id = newId()): string {
  env.db
    .prepare(
      `INSERT INTO consolidation_candidates
         (id, kind, status, project, member_ids, member_hash, canonical_id, score, proposal, detected_at)
       VALUES (?, 'merge', 'pending', NULL, ?, ?, NULL, ?, NULL, ?)`,
    )
    .run(id, JSON.stringify([newId()]), id, score, detectedAt);

  return id;
}

function suggest(args: Record<string, unknown>): Promise<SuggestCandidatesResult> {
  return container.resolve<SuggestCandidates>(SUGGEST_CANDIDATES).invoke(args);
}

// Bounded on purpose. A cursor bug that fails to advance makes this loop forever, and a
// hanging suite is a far worse signal than a failing assertion.
const MAX_PAGES = 50;

async function pageThrough(pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (++pages > MAX_PAGES) throw new Error(`cursor did not terminate after ${MAX_PAGES} pages`);

    const page: SuggestCandidatesResult = await suggest({
      page_size: pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    });

    seen.push(...page.candidates.map((c) => c.id));
    cursor = page.next_cursor;
  } while (cursor !== undefined);

  return seen;
}

beforeEach(() => {
  env = setup();
});

describe("Cursor encoding", () => {
  it("should round-trip a position", () => {
    // Given / When
    const cursor = encodeCursor({
      key: "candidates",
      after: [0.5, "2026-01-01T00:00:00.000Z", "x"],
    });

    // Then
    expect(decodeCursor(cursor, "candidates")).toEqual({
      key: "candidates",
      after: [0.5, "2026-01-01T00:00:00.000Z", "x"],
    });
  });

  it("should reject anything it did not issue", () => {
    // Given / When / Then
    expect(decodeCursor("not-base64!!", "candidates")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"), "candidates")).toBeNull();
    expect(
      decodeCursor(
        Buffer.from('{"v":99,"k":"candidates","a":[]}').toString("base64url"),
        "candidates",
      ),
    ).toBeNull();
  });

  it("should reject a cursor issued for a different ordering", () => {
    // Given
    const foreign = Buffer.from('{"v":1,"k":"something-else","a":[1]}').toString("base64url");

    // When / Then
    expect(decodeCursor(foreign, "candidates")).toBeNull();
  });

  it("should clamp the page size instead of trusting it", () => {
    // Given / When / Then
    expect(pageSizeOf(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSizeOf(0)).toBe(1);
    expect(pageSizeOf(-5)).toBe(1);
    expect(pageSizeOf(10_000)).toBe(MAX_PAGE_SIZE);
    expect(pageSizeOf(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(pageSizeOf(7.9)).toBe(7);
  });

  it("should treat a full page as possibly-not-last", () => {
    // Given / When / Then — the overfetched row is what distinguishes the two.
    expect(splitOverfetch([1, 2, 3], 3)).toEqual({ items: [1, 2, 3], hasMore: false });
    expect(splitOverfetch([1, 2, 3, 4], 3)).toEqual({ items: [1, 2, 3], hasMore: true });
  });
});

describe("Paging the review queue", () => {
  it("should walk every candidate exactly once across pages", async () => {
    // Given
    const ids = Array.from({ length: 11 }, (_, i) =>
      candidate(0.9 - i * 0.01, `2026-01-0${String((i % 9) + 1)}T00:00:00.000Z`),
    );

    // When
    const seen = await pageThrough(4);

    // Then
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("should not repeat or skip a row when scores and timestamps collide", async () => {
    // Given — the case a non-total order gets wrong: every row identical but for its id.
    const ids = Array.from({ length: 9 }, () => candidate(0.5, "2026-01-01T00:00:00.000Z"));

    // When
    const seen = await pageThrough(2);

    // Then
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("should not re-show a row when a higher-ranked candidate is inserted mid-walk", async () => {
    // Given
    for (let i = 0; i < 6; i++) {
      candidate(0.5 - i * 0.01, "2026-01-01T00:00:00.000Z");
    }
    const first = await suggest({ page_size: 3 });
    expect(first.next_cursor).toBeDefined();

    // When — an offset would shift every later row down by one and repeat one.
    candidate(0.99, "2026-01-01T00:00:00.000Z");
    const second = await suggest({ page_size: 3, cursor: first.next_cursor });

    // Then
    const overlap = second.candidates.filter((c) => first.candidates.some((f) => f.id === c.id));
    expect(overlap).toEqual([]);
  });

  it("should stop without a cursor on the last page", async () => {
    // Given
    candidate(0.5, "2026-01-01T00:00:00.000Z");
    candidate(0.4, "2026-01-01T00:00:00.000Z");

    // When
    const page = await suggest({ page_size: 10 });

    // Then
    expect(page.candidates).toHaveLength(2);
    expect(page.next_cursor).toBeUndefined();
  });

  it("should keep the filter across pages", async () => {
    // Given
    for (let i = 0; i < 4; i++) candidate(0.5 - i * 0.01, "2026-01-01T00:00:00.000Z");
    env.db.prepare("UPDATE consolidation_candidates SET kind = 'link' WHERE score < 0.49").run();

    // When
    const first = await suggest({ kind: ConsolidationKind.MERGE, page_size: 1 });
    const second = await suggest({
      kind: ConsolidationKind.MERGE,
      page_size: 1,
      cursor: first.next_cursor,
    });

    // Then
    expect(first.candidates[0]!.kind).toBe(ConsolidationKind.MERGE);
    expect(second.candidates[0]!.kind).toBe(ConsolidationKind.MERGE);
    expect(second.next_cursor).toBeUndefined();
  });

  it("should refuse a cursor it did not issue rather than silently restarting", async () => {
    // Given
    candidate(0.5, "2026-01-01T00:00:00.000Z");

    // When / Then — silently restarting would make a client loop forever.
    await expect(suggest({ page_size: 1, cursor: "garbage" })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  it("should answer a pre-cursor caller exactly as before", async () => {
    // Given
    for (let i = 0; i < 3; i++) candidate(0.5 - i * 0.01, "2026-01-01T00:00:00.000Z");

    // When — no page_size and no cursor is the old contract.
    const page = await suggest({ limit: 2 });

    // Then
    expect(page.candidates).toHaveLength(2);
    expect(page.next_cursor).toBeUndefined();
  });
});
