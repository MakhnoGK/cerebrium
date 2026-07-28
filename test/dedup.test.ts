import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";
import { container } from "tsyringe";
import { _MemoryKind } from "../src/core/vocab";
import { EmbeddingWorker } from "../src/embeddings/worker";
import { CONSOLIDATOR_TOKEN } from "../src/tools/services/consolidation.service";
import { createConsolidator } from "../src/consolidation";
import { EMBEDDING_PROVIDER_TOKEN } from "../src/embeddings";
import { LocalNullProvider } from "../src/embeddings/local-null";
import { DB_TOKEN } from "../src/db/repositories/base";
import { openDatabase } from "../src/db/database";

async function session(tool: SessionStartTool, project?: string): Promise<string> {
  return (await tool.invoke({ project })).session_id;
}

function writeFact(
  writeTool: WriteTool,
  s: string,
  title: string,
  content: string,
  project?: string,
) {
  return writeTool.invoke({
    session_id: s,
    memory_kind: _MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
    project,
  });
}

const P = "billing";
const ORIGINAL =
  "Access tokens live fifteen minutes before they expire and then must be refreshed by the client";

describe("duplicate detection at write time", () => {
  let sessionTool: SessionStartTool;
  let writeTool: WriteTool;
  let worker: EmbeddingWorker;

  beforeAll(() => {
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });
    container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });
  });

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });

    sessionTool = container.resolve(SessionStartTool);
    writeTool = container.resolve(WriteTool);
    worker = container.resolve(EmbeddingWorker);
  });

  it("fires on a near-duplicate and stays silent on an unrelated write", async () => {
    const s = await session(sessionTool, P);
    const original = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P);
    await worker.tick(); // embed the original so the vector probe can find it

    const dup = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P); // same fact again

    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.similar_existing![0]!.score).toBeGreaterThanOrEqual(0.82);
    expect((dup.context_notes ?? []).some((n) => n.startsWith("Possible duplicate of"))).toBe(true);

    const unrelated = await writeFact(
      writeTool,
      s,
      "Deploy cadence",
      "we ship the mobile app every second thursday",
      P,
    );
    expect(unrelated.similar_existing).toBeUndefined();
    expect((unrelated.context_notes ?? []).some((n) => n.startsWith("Possible duplicate of"))).toBe(
      false,
    );
  });

  it("checkpoints/episodic writes are exempt from the probe", async () => {
    const s = await session(sessionTool, P);
    await writeFact(writeTool, "Token TTL", ORIGINAL, P);
    await worker.tick();

    const note = await writeTool.invoke({
      session_id: s,
      memory_kind: _MemoryKind.EPISODIC,
      type: "event_note",
      title: "Token TTL",
      content: ORIGINAL,
      project: P,
    });

    expect(note.similar_existing).toBeUndefined();
  });

  it("falls back to a lexical probe when nothing is embedded yet", async () => {
    const s = await session(sessionTool, P);
    const original = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P); // never drained
    const dup = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P);

    expect(dup.similar_existing?.[0]?.id).toBe(original.id); // caught via Jaccard fallback
  });
});
