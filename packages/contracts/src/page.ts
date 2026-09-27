// The pagination convention, shared by every paged read. It sits in core because both the
// use-case contracts and the wire protocol need it, and because getting it wrong is a
// correctness problem rather than a formatting one.
//
// Keyset, not offset. The daemon writes while clients read, so an offset silently skips a
// row when something is inserted ahead of the page boundary and repeats one when something
// is removed. A cursor naming the last row's position has neither failure.

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface PageRequest {
  page_size?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  // Absent on the last page. Present means "there is more", so a client loops until it is
  // gone rather than until it sees a short page — a full page can still be the last one.
  next_cursor?: string;
}

// The ordering a cursor was issued against. Replaying a cursor from one query against a
// different one would land at a meaningless position, so the key travels inside the cursor
// and is checked on the way back in.
export type CursorKey = "candidates";

export interface CursorPosition {
  key: CursorKey;
  // Ordering columns of the last row on the previous page, in order. Strings and numbers
  // only: this is JSON on the wire.
  after: (string | number)[];
}

const VERSION = 1;

export function encodeCursor(position: CursorPosition): string {
  const payload = JSON.stringify({ v: VERSION, k: position.key, a: position.after });

  return Buffer.from(payload, "utf8").toString("base64url");
}

// Opaque to clients, and treated as hostile: a cursor is decoded, validated and rejected,
// never trusted into a query. Returns null for anything that is not a cursor this build
// issued for this ordering.
export function decodeCursor(cursor: string, key: CursorKey): CursorPosition | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const { v, k, a } = parsed as { v?: unknown; k?: unknown; a?: unknown };

  if (v !== VERSION || k !== key || !Array.isArray(a)) return null;

  const after = a.filter(
    (x): x is string | number => typeof x === "string" || typeof x === "number",
  );

  return after.length === a.length ? { key, after } : null;
}

export function pageSizeOf(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE;

  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)));
}

// Fetching one extra row is how "is there a next page" is answered without a second count
// query, and without the off-by-one of treating a full page as the last one.
export function splitOverfetch<T>(rows: T[], pageSize: number): { items: T[]; hasMore: boolean } {
  return rows.length > pageSize
    ? { items: rows.slice(0, pageSize), hasMore: true }
    : { items: rows, hasMore: false };
}
