import { createRequire } from "node:module";
import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/025_normalize_edge_timestamps.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

let env: TestEnv;
let session: string;

async function node(title: string): Promise<string> {
  const written = (await container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a body of a few words`,
  })) as { id: string };

  return written.id;
}

// Exactly what SQLite's `datetime('now')` writes: the right instant, the wrong format.
function writeRaw(src: string, dst: string, valid_from: string, invalidated_at: string | null) {
  env.db
    .prepare(
      `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, invalidated_at, session_id)
       VALUES (?, ?, ?, 'agent', 1.0, ?, ?, ?)`,
    )
    .run(src, dst, EdgeType.RELATES_TO, valid_from, invalidated_at, session);
}

function storedTimes(src: string): { valid_from: string; invalidated_at: string | null } {
  return env.db.prepare("SELECT valid_from, invalidated_at FROM edges WHERE src = ?").get(src) as {
    valid_from: string;
    invalidated_at: string | null;
  };
}

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Normalising edge timestamps written out of band", () => {
  it("should reformat a space-separated timestamp without moving the instant", async () => {
    // Given
    const src = await node("Source");
    const dst = await node("Target");
    writeRaw(src, dst, "2026-08-21 07:20:47", null);

    // When
    up(env.db);

    // Then — same instant, and now parseable as UTC rather than as local time.
    expect(storedTimes(src).valid_from).toBe("2026-08-21T07:20:47.000Z");
    expect(Date.parse("2026-08-21T07:20:47.000Z")).toBe(Date.UTC(2026, 7, 21, 7, 20, 47));
  });

  it("should repair a retirement stamp the same way", async () => {
    // Given
    const src = await node("Retired source");
    const dst = await node("Retired target");
    writeRaw(src, dst, "2026-08-21 07:20:47", "2026-08-21 09:00:00");

    // When
    up(env.db);

    // Then
    expect(storedTimes(src)).toEqual({
      valid_from: "2026-08-21T07:20:47.000Z",
      invalidated_at: "2026-08-21T09:00:00.000Z",
    });
  });

  it("should leave a properly formatted timestamp alone", async () => {
    // Given — every edge the writer creates already looks like this.
    const src = await node("Well formed source");
    const dst = await node("Well formed target");
    const iso = "2026-08-20T18:52:36.965Z";
    writeRaw(src, dst, iso, null);

    // When
    up(env.db);

    // Then
    expect(storedTimes(src).valid_from).toBe(iso);
  });

  it("should be safe to run twice", async () => {
    // Given — migrations re-run when a ledger row goes missing.
    const src = await node("Twice source");
    const dst = await node("Twice target");
    writeRaw(src, dst, "2026-08-21 07:20:47", null);

    // When
    up(env.db);
    up(env.db);

    // Then — no second suffix appended.
    expect(storedTimes(src).valid_from).toBe("2026-08-21T07:20:47.000Z");
  });
});
