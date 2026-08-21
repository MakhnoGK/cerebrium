import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { HintsService } from "@/application/services";
import { ConsolidationRepo } from "@/db/repositories";
import { ConsolidationKind, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let session: string;

async function candidateFrom(title: string): Promise<void> {
  const { id } = await container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `${title} — a durable fact with enough words in it to be worth a chunk`,
  });

  container.resolve(ConsolidationRepo).insertCandidate({
    kind: ConsolidationKind.PRUNE,
    member_ids: [id],
    score: 1,
    detected_at: "2026-01-01T00:00:00.000Z",
  });
}

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Session hints", () => {
  it("should say nothing when there is nothing waiting", async () => {
    // Given / When / Then
    await expect(container.resolve(HintsService).getSessionHints(session)).resolves.toEqual([]);
  });

  it("should name the review backlog the first time a session asks", async () => {
    // Given
    await candidateFrom("One");
    await candidateFrom("Two");

    // When / Then
    await expect(container.resolve(HintsService).getSessionHints(session)).resolves.toEqual([
      "2 consolidation candidates awaiting review — consolidate_suggest lists them.",
    ]);
  });

  it("should not repeat a figure the session has already been told", async () => {
    // Given
    await candidateFrom("One");

    const hints = container.resolve(HintsService);

    expect(await hints.getSessionHints(session)).toHaveLength(1);

    // When / Then — every tool call asks, and the same number twice says nothing new
    expect(await hints.getSessionHints(session)).toEqual([]);
  });

  it("should speak again once the backlog changes", async () => {
    // Given
    await candidateFrom("One");

    const hints = container.resolve(HintsService);
    await hints.getSessionHints(session);

    // When
    await candidateFrom("Two");

    // Then
    expect(await hints.getSessionHints(session)).toEqual([
      "2 consolidation candidates awaiting review — consolidate_suggest lists them.",
    ]);
  });

  it("should tell a different session the figure it has not heard", async () => {
    // Given
    await candidateFrom("One");

    const hints = container.resolve(HintsService);
    await hints.getSessionHints(session);

    // When
    const other = (await container.resolve(SessionStartTool).invoke({})).session_id;

    // Then
    expect(await hints.getSessionHints(other)).toHaveLength(1);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
  });
});
