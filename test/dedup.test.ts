import { container } from "tsyringe";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { EmbeddingWorker } from "@/application/workers";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { LocalNullProvider } from "@/embeddings/local-null";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { createConsolidator } from "@/consolidation";
import { RetrievalConfig } from "@/infrastructure/config";

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
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
    project,
  });
}

const P = "billing";
const ORIGINAL =
  "Access tokens live fifteen minutes before they expire and then must be refreshed by the client";

describe("Duplicate detection at write time", () => {
  let sessionTool: SessionStartTool;
  let writeTool: WriteTool;
  let worker: EmbeddingWorker;

  beforeAll(() => {
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });
    container.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
  });

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });

    sessionTool = container.resolve(SessionStartTool);
    writeTool = container.resolve(WriteTool);
    worker = container.resolve(EmbeddingWorker);
  });

  it("should flag a possible duplicate when a near-identical fact is written and stay silent when the write is unrelated", async () => {
    // Given
    const s = await session(sessionTool, P);
    const original = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P);
    await worker.tick(); // embed the original so the vector probe can find it

    // When
    const dup = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P); // same fact again

    // Then
    expect(dup.similar_existing?.[0]?.id).toBe(original.id);
    expect(dup.similar_existing![0]!.score).toBeGreaterThanOrEqual(
      container.resolve(RetrievalConfig).dedupThreshold,
    );
    expect(dup.similar_existing![0]!.confidence).toBe("high");
    expect((dup.context_notes ?? []).some((n) => n.startsWith("Possible duplicate of"))).toBe(true);

    // When / Then
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

  it("should skip the duplicate probe when the write is episodic", async () => {
    // Given
    const s = await session(sessionTool, P);
    await writeFact(writeTool, "Token TTL", ORIGINAL, P);
    await worker.tick();

    // When
    const note = await writeTool.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "event_note",
      title: "Token TTL",
      content: ORIGINAL,
      project: P,
    });

    // Then
    expect(note.similar_existing).toBeUndefined();
  });

  it("should fall back to a lexical probe when nothing is embedded yet", async () => {
    // Given
    const s = await session(sessionTool, P);
    const original = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P); // never drained

    // When
    const dup = await writeFact(writeTool, s, "Token TTL", ORIGINAL, P);

    // Then
    expect(dup.similar_existing?.[0]?.id).toBe(original.id); // caught via Jaccard fallback
  });
});
