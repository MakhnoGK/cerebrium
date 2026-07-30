import type BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventAction } from "@/core/vocab";
import { actionForTool } from "@/presentation/mcp/adapters";
import { McpTool, ToolName } from "@/presentation/mcp/tools/contracts";
import { callTool, setup } from "@test/helpers";

const SCHEMA = { session_id: z.string() };

type Schema = typeof SCHEMA;

interface Result {
  id: string;
}

interface EventRow {
  session_id: string;
  action: string;
  node_id: string | null;
  detail: string | null;
}

function stub(overrides: Partial<McpTool<Schema, Result>> = {}): McpTool<Schema, Result> {
  return {
    getMetadata: () => ({ name: ToolName.WRITE, description: "stub", schema: SCHEMA }),
    invoke: () => Promise.resolve({ id: "n1" }),
    ...overrides,
  };
}

function events(db: BetterSqlite3.Database): EventRow[] {
  return db.prepare("SELECT * FROM events ORDER BY rowid").all() as EventRow[];
}

describe("AuditedTool", () => {
  it("should append one row with the tool's action and the session from args when a call succeeds", async () => {
    // Given
    const { db } = setup();

    // When
    const result = await callTool(stub(), { session_id: "s1" });

    // Then
    expect(result).toEqual({ id: "n1" });
    expect(events(db)).toHaveLength(1);
    expect(events(db)[0]).toMatchObject({
      action: EventAction.WRITE,
      session_id: "s1",
      node_id: null,
      detail: null,
    });
  });

  it("should record the node_id and detail a tool describes", async () => {
    // Given
    const { db } = setup();
    const tool = stub({
      describeEvent: (_args, result) => ({ node_id: result.id, detail: { type: "fact" } }),
    });

    // When
    await callTool(tool, { session_id: "s1" });

    // Then
    const [row] = events(db);
    expect(row?.node_id).toBe("n1");
    expect(JSON.parse(row!.detail!)).toEqual({ type: "fact" });
  });

  it("should write one row per described event when a tool describes several", async () => {
    // Given
    const { db } = setup();
    const tool = stub({
      describeEvent: () => [{ detail: { repo: "a" } }, { detail: { repo: "b" } }],
    });

    // When
    await callTool(tool, { session_id: "s1" });

    // Then
    expect(events(db).map((row) => JSON.parse(row.detail!) as unknown)).toEqual([
      { repo: "a" },
      { repo: "b" },
    ]);
  });

  it("should write nothing when a tool describes an empty list of events", async () => {
    // Given
    const { db } = setup();
    const tool = stub({ describeEvent: () => [] });

    // When
    await callTool(tool, { session_id: "s1" });

    // Then
    expect(events(db)).toHaveLength(0);
  });

  it("should prefer the session a tool describes over the one in args", async () => {
    // Given
    const { db } = setup();
    const tool = stub({ describeEvent: () => ({ session_id: "minted" }) });

    // When
    await callTool(tool, { session_id: "s1" });

    // Then
    expect(events(db)[0]?.session_id).toBe("minted");
  });

  it("should append an error row and rethrow when the tool throws", async () => {
    // Given
    const { db } = setup();
    const tool = stub({ invoke: () => Promise.reject(new Error("episodic is write-once")) });

    // When
    await expect(callTool(tool, { session_id: "s1" })).rejects.toThrow("episodic is write-once");

    // Then
    const [row] = events(db);
    expect(row).toMatchObject({ action: EventAction.WRITE, session_id: "s1", node_id: null });
    expect(JSON.parse(row!.detail!)).toEqual({ error: "episodic is write-once" });
  });

  it("should skip the row when the call cannot be attributed to a session", async () => {
    // Given
    const { db } = setup();
    const tool = stub({
      getMetadata: () => ({ name: ToolName.SESSION_START, description: "stub", schema: SCHEMA }),
      invoke: () => Promise.reject(new Error("db is locked")),
    });

    // When
    await expect(callTool(tool, {} as unknown as { session_id: string })).rejects.toThrow(
      "db is locked",
    );

    // Then
    expect(events(db)).toHaveLength(0);
  });
});

describe("actionForTool", () => {
  it("should map every tool name to the identically-valued event action", () => {
    // Given / When / Then
    for (const name of Object.values(ToolName)) {
      expect(actionForTool(name)).toBe(name as string as EventAction);
    }

    expect(Object.values(ToolName)).toHaveLength(Object.values(EventAction).length);
  });
});
