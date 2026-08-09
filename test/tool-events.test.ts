import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EventAction, MemoryKind } from "@/core/vocab";
import { CheckpointTool } from "@/presentation/mcp/tools/checkpoint";
import { CodeIndexTool } from "@/presentation/mcp/tools/code-index";
import { CodeLookupTool } from "@/presentation/mcp/tools/code-lookup";
import { GetTool } from "@/presentation/mcp/tools/get";
import { SearchTool } from "@/presentation/mcp/tools/search";
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
    expect(detailOf(row)).toEqual({ project: "cerebrium", ids: [] });
  });

  it("should log the node ids the working set surfaced", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const task = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
      title: "An open task",
      content: "Close the read loop.",
      type: "task",
      memory_kind: MemoryKind.SEMANTIC,
      project: "cerebrium",
    });
    const checkpoint = await callTool(container.resolve(CheckpointTool), {
      session_id,
      title: "Where we left off.",
      summary: "Where we left off.",
      project: "cerebrium",
    });

    // When
    await callTool(container.resolve(SessionStartTool), { project: "cerebrium" });

    // Then
    const rows = eventsFor(db, EventAction.SESSION_START);
    const detail = detailOf(rows.at(-1)) as { ids: string[] };
    expect(detail.ids).toEqual(expect.arrayContaining([task.id, checkpoint.id]));
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
      parent_node_id: null,
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
      parent_node_id: null,
      title: "One",
      content: "First.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    const envelope = await callTool(container.resolve(CheckpointTool), {
      session_id,
      title: "Where we left off.",
      summary: "Where we left off.",
      touched_node_ids: [first.id],
    });

    // Then
    const [row] = eventsFor(db, EventAction.CHECKPOINT);
    expect(row?.node_id).toBe(envelope.id);
    expect(detailOf(row)).toEqual({ touched: 1 });
  });
});

describe("GetTool.describeEvent", () => {
  it("should log the requested ids and how many resolved", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const envelope = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
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
    expect(detailOf(row)).toEqual({
      ids: [envelope.id, "missing"],
      found: 1,
      not_found: ["missing"],
    });
  });

  it("should omit not_found when every requested id resolved", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const envelope = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
      title: "A fact",
      content: "Something durable.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    await callTool(container.resolve(GetTool), { session_id, ids: [envelope.id] });

    // Then
    const [row] = eventsFor(db, EventAction.GET);
    expect(detailOf(row)).toEqual({ ids: [envelope.id], found: 1 });
  });

  it("should log which sections were read when the fetch was narrowed", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const envelope = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
      title: "A fact",
      content: "## Ranking\nHybrid fusion.\n\n## Storage\nOne SQLite file.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    await callTool(container.resolve(GetTool), {
      session_id,
      ids: [envelope.id],
      sections: ["H2: Storage"],
    });

    // Then
    const [row] = eventsFor(db, EventAction.GET);
    expect(detailOf(row)).toEqual({
      ids: [envelope.id],
      found: 1,
      sections: ["H2: Storage"],
    });
  });

  it("should mark an outline fetch so it is not counted as a read", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const envelope = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
      title: "A fact",
      content: "## Ranking\nHybrid fusion.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    await callTool(container.resolve(GetTool), {
      session_id,
      ids: [envelope.id],
      outline: true,
    });

    // Then
    const [row] = eventsFor(db, EventAction.GET);
    expect(detailOf(row)).toEqual({ ids: [envelope.id], found: 1, outline: true });
  });
});

describe("SearchTool.describeEvent", () => {
  it("should log the query and the returned ids in rank order", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const write = container.resolve(WriteTool);
    const fact = await callTool(write, {
      session_id,
      parent_node_id: null,
      title: "Deploy pipeline",
      content: "The release pipeline deploys on merge.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });
    await callTool(write, {
      session_id,
      parent_node_id: null,
      title: "Unrelated",
      content: "Nothing to do with shipping.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    const result = await callTool(container.resolve(SearchTool), {
      session_id,
      query: "release pipeline",
      limit: 10,
    });

    // Then
    const [row] = eventsFor(db, EventAction.SEARCH);
    expect(result.results.map((e) => e.id)).toEqual([fact.id]);
    expect(detailOf(row)).toMatchObject({
      mode: "hybrid",
      query: "release pipeline",
      results: 1,
      ids: [fact.id],
    });
  });

  it("should log the ids of a text-mode search under its own mode", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const fact = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
      title: "Deploy pipeline",
      content: "The release pipeline deploys on merge.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    await callTool(container.resolve(SearchTool), {
      session_id,
      query: "release pipeline",
      mode: "text",
      limit: 10,
    });

    // Then
    const [row] = eventsFor(db, EventAction.SEARCH);
    expect(detailOf(row)).toEqual({
      mode: "text",
      query: "release pipeline",
      results: 1,
      ids: [fact.id],
      matched: ["text"],
    });
  });

  it("should log an empty outcome when the query has no searchable terms", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();

    // When
    await callTool(container.resolve(SearchTool), { session_id, query: "***", limit: 10 });

    // Then
    const [row] = eventsFor(db, EventAction.SEARCH);
    expect(detailOf(row)).toEqual({
      mode: "hybrid",
      query: "***",
      results: 0,
      ids: [],
      matched: [],
    });
  });

  it("should log the retrieval path each result surfaced through, parallel to the ids", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    const fact = await callTool(container.resolve(WriteTool), {
      session_id,
      parent_node_id: null,
      title: "Deploy pipeline",
      content: "The release pipeline deploys on merge.",
      type: "fact",
      memory_kind: MemoryKind.SEMANTIC,
    });

    // When
    await callTool(container.resolve(SearchTool), {
      session_id,
      query: "release pipeline",
      limit: 10,
    });

    // Then
    const [row] = eventsFor(db, EventAction.SEARCH);
    const detail = detailOf(row) as { ids: string[]; matched: string[] };
    expect(detail.ids).toEqual([fact.id]);
    expect(detail.matched).toHaveLength(detail.ids.length);
    expect(detail.matched[0]).toMatch(/^(text|vector|both|graph)$/);
  });
});

describe("CodeLookupTool.describeEvent", () => {
  it("should log the lookup key and the symbol ids it surfaced", async () => {
    // Given
    const { db } = setup();
    const session_id = await session();
    await callTool(container.resolve(CodeIndexTool), { session_id, path: FIXTURE });

    // When
    const result = await callTool(container.resolve(CodeLookupTool), {
      session_id,
      file: "util/crypto.ts",
      limit: 10,
    });

    // Then
    const [row] = eventsFor(db, EventAction.CODE_LOOKUP);
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(detailOf(row)).toEqual({
      file: "util/crypto.ts",
      results: result.symbols.length,
      ids: result.symbols.map((s) => s.id),
    });
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
