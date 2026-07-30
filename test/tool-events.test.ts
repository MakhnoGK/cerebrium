import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EventAction, MemoryKind } from "@/core/vocab";
import { CheckpointTool } from "@/presentation/mcp/tools/checkpoint";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { GetTool } from "@/presentation/mcp/tools/get";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { callTool, setup } from "@test/helpers";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/demo-repo");

interface EventRow {
  session_id: string;
  action: string;
  node_id: string | null;
  detail: string | null;
}

function eventsFor(db: BetterSqlite3.Database, action: EventAction): EventRow[] {
  return db
    .prepare("SELECT * FROM events WHERE action = ? ORDER BY rowid")
    .all(action) as EventRow[];
}

function detailOf(row: EventRow | undefined): unknown {
  return JSON.parse(row?.detail ?? "null");
}

async function session(): Promise<string> {
  const { session_id } = await callTool(container.resolve(SessionStartTool), {});

  return session_id;
}

describe("SessionStartTool.describeEvent", () => {
  it("should log the minted session id and the project", async () => {
    // Given
    const { db } = setup();

    // When
    const result = await callTool(container.resolve(SessionStartTool), { project: "cerebrium" });

    // Then
    const [row] = eventsFor(db, EventAction.SESSION_START);
    expect(row?.session_id).toBe(result.session_id);
    expect(detailOf(row)).toEqual({ project: "cerebrium" });
  });
});

describe("WriteTool.describeEvent", () => {
  it("should log the new node id with its type and kind", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();

    // When
    const envelope = await callTool(container.resolve(WriteTool), {
      session_id,
      title: "A fact",
      content: "Something durable.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // Then
    const [row] = eventsFor(db, EventAction.WRITE);
    expect(row?.node_id).toBe(envelope.id);
    expect(row?.session_id).toBe(session_id);
    expect(detailOf(row)).toEqual({ type: "fact", kind: MemoryKind.SEMANTIC });
  });
});

describe("CheckpointTool.describeEvent", () => {
  it("should log the checkpoint node id and how many touched nodes it linked", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const first = await callTool(container.resolve(WriteTool), {
      session_id,
      title: "One",
      content: "First.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    const envelope = await callTool(container.resolve(CheckpointTool), {
      session_id,
      summary: "Where we left off.",
      touched_node_ids: [first.id, "01JUNKJUNKJUNKJUNKJUNKJUNK"],
    });

    // Then
    const [row] = eventsFor(db, EventAction.CHECKPOINT);
    expect(row?.node_id).toBe(envelope.id);
    expect(detailOf(row)).toEqual({ touched: 1 });
  });
});

describe("GetTool.describeEvent", () => {
  it("should log the first requested id and how many were asked for", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const envelope = await callTool(container.resolve(WriteTool), {
      session_id,
      title: "A fact",
      content: "Something durable.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    await callTool(container.resolve(GetTool), { session_id, ids: [envelope.id, "missing"] });

    // Then
    const [row] = eventsFor(db, EventAction.GET);
    expect(row?.node_id).toBe(envelope.id);
    expect(detailOf(row)).toEqual({ count: 2 });
  });
});

describe("CodeIndexTool.describeEvent", () => {
  it("should log one row per indexed repo with its counters and git provenance", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();

    // When
    await callTool(container.resolve(CodeIndexTool), { session_id, path: FIXTURE });

    // Then
    const rows = eventsFor(db, EventAction.CODE_INDEX);
    expect(rows).toHaveLength(1);
    expect(detailOf(rows[0])).toMatchObject({
      repo: "demo-repo",
      indexed: 2,
      updated: 0,
      invalidated: 0,
    });
    expect(detailOf(rows[0])).toHaveProperty("branch");
    expect(detailOf(rows[0])).toHaveProperty("commit");
  });
});
