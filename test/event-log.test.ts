import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EventLogService } from "@/application/services";
import { EventAction } from "@/core/vocab";
import { setup } from "@test/helpers";

interface EventRow {
  session_id: string;
  action: string;
  node_id: string | null;
  detail: string | null;
  ts: string;
}

function rows(db: { prepare: (sql: string) => { all: () => unknown[] } }): EventRow[] {
  return db.prepare("SELECT * FROM events ORDER BY rowid").all() as EventRow[];
}

describe("EventLogService", () => {
  it("should write one row per draft, stamped with the clock", () => {
    // Given
    const { db, clock } = setup({ start: "2026-03-01T10:00:00.000Z" });
    const log = container.resolve(EventLogService);

    // When
    log.record([
      { action: EventAction.WRITE, session_id: "s1", node_id: "n1", detail: { type: "fact" } },
      { action: EventAction.GET, session_id: "s1", node_id: "n1", detail: { count: 2 } },
    ]);

    // Then
    const written = rows(db);
    expect(written).toHaveLength(2);
    expect(written.map((r) => r.action)).toEqual([EventAction.WRITE, EventAction.GET]);
    expect(written.every((r) => r.ts === clock.now())).toBe(true);
    expect(JSON.parse(written[0]!.detail!)).toEqual({ type: "fact" });
  });

  it("should store nulls when a draft omits node_id and detail", () => {
    // Given
    const { db } = setup();
    const log = container.resolve(EventLogService);

    // When
    log.record([{ action: EventAction.STATS, session_id: "s1" }]);

    // Then
    expect(rows(db)[0]).toMatchObject({ node_id: null, detail: null });
  });

  it("should be a no-op when handed no drafts", () => {
    // Given
    const { db } = setup();
    const log = container.resolve(EventLogService);

    // When
    log.record([]);

    // Then
    expect(rows(db)).toHaveLength(0);
  });

  it("should swallow the error when the audit row cannot be written", () => {
    // Given
    const { db } = setup();
    const log = container.resolve(EventLogService);
    db.exec("DROP TABLE events");

    // When / Then
    expect(() => {
      log.record([{ action: EventAction.SEARCH, session_id: "s1" }]);
    }).not.toThrow();
  });
});
