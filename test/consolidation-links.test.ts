import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { ConsolidationWorker, EmbeddingWorker } from "@/application/workers";
import { openDatabase } from "@/db/database";
import type { Envelope } from "@/db/repo";
import { DB_TOKEN } from "@/db/repositories/base";
import { ConsolidationRepo } from "@/db/repositories/consolidation";
import { EdgesRepo } from "@/db/repositories/edges";
import { LocalNullProvider } from "@/embeddings/local-null";
import { ConsolidationKind, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { createConsolidator } from "@/consolidation";

const sessionStart = container.resolve(SessionStartTool);
let edgesRepo: EdgesRepo;
let consolidationRepo: ConsolidationRepo;

async function newNode(
  writeTool: WriteTool,
  s: string,
  title: string,
  content: string,
): Promise<string> {
  return (
    (await writeTool.invoke({
      session_id: s,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content,
    })) as Envelope
  ).id;
}

async function newEpisodic(
  tool: WriteTool,
  s: string,
  title: string,
  content: string,
): Promise<string> {
  return (
    (await tool.invoke({
      session_id: s,
      memory_kind: MemoryKind.EPISODIC,
      type: "event_note",
      title,
      content,
    })) as Envelope
  ).id;
}

async function seed(tool: WriteTool, worker: EmbeddingWorker) {
  const s = (await sessionStart.invoke({})).session_id;
  // Two nodes with identical content -> identical local-null vectors (cosine 1.0);
  // a third, disjoint node stays unlinked.
  const dup = "the http client retries three times with exponential backoff";
  const twinA = await newNode(tool, s, "Retry budget", dup);
  const twinB = await newNode(tool, s, "Client retries", dup);
  const other = await newNode(tool, s, "Kafka", "ingestion consumes kafka topics by tenant");
  await worker.tick(); // embed all three so the kNN detector has vectors

  return { s, twinA, twinB, other };
}

function edgeTypesBetween(a: string, b: string): string[] {
  return edgesRepo
    .edgesOf(a)
    .filter((e) => e.id === b)
    .map((e) => e.edge);
}

afterEach(() => {
  delete process.env.MEMORY_CONSOLIDATE_LINKS;
  delete process.env.MEMORY_CONSOLIDATE_SIM;
});

describe("Similar node link discovery", () => {
  let writeTool: WriteTool;
  let embedWorker: EmbeddingWorker;
  let consolidation: ConsolidationWorker;

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    container.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });

    embedWorker = container.resolve(EmbeddingWorker);
    consolidation = container.resolve(ConsolidationWorker);
    writeTool = container.resolve(WriteTool);
    edgesRepo = container.resolve(EdgesRepo);
    consolidationRepo = container.resolve(ConsolidationRepo);
  });

  it("should write a system similar_to edge between near-identical nodes only when posture is auto", async () => {
    // Given
    const { twinA, twinB, other } = await seed(writeTool, embedWorker);

    // When
    const consolidationResult = await consolidation.tick();

    // Then
    expect(consolidationResult.links_added).toBe(1);
    expect(edgeTypesBetween(twinA, twinB)).toContain("similar_to");
    expect(edgeTypesBetween(twinA, other)).not.toContain("similar_to");
  });

  it("should add no duplicate edge when a second sweep runs", async () => {
    // Given
    await seed(writeTool, embedWorker);

    // When / Then
    expect((await consolidation.tick()).links_added).toBe(1);
    // When / Then
    expect((await consolidation.tick()).links_added).toBe(0);
  });

  it("should write a system-provenance edge that graph expansion can traverse when near-identical nodes exist", async () => {
    // Given
    const { twinA, twinB } = await seed(writeTool, embedWorker);
    await consolidation.tick();

    // When
    // neighborsOf is what search uses for 1-hop graph expansion: the discovered
    // similar_to edge makes each twin a neighbor of the other.
    const neighbors = edgesRepo.neighborsOf([twinA]);
    const hit = neighbors.find((n) => n.node.id === twinB);

    // Then
    expect(hit).toBeDefined();
    expect(hit!.edge).toBe("similar_to");
  });

  it("should queue a link candidate instead of writing an edge when posture is suggest", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";
    const { twinA, twinB } = await seed(writeTool, embedWorker);

    // When
    const consolidationResult = await consolidation.tick();

    // Then
    expect(consolidationResult.links_suggested).toBe(1);
    expect(consolidationResult.links_added).toBe(0);
    expect(edgeTypesBetween(twinA, twinB)).not.toContain("similar_to");

    const pending = consolidationRepo.pendingCandidates({ kind: ConsolidationKind.LINK });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.member_ids.sort()).toEqual([twinA, twinB].sort());
  });

  it("should do nothing when posture is off", async () => {
    // Given
    process.env.MEMORY_CONSOLIDATE_LINKS = "off";
    await seed(writeTool, embedWorker);

    // When
    const consolidationResult = await consolidation.tick();

    // Then
    expect(consolidationResult).toMatchObject({ links_added: 0, links_suggested: 0 });
  });
});

describe("Orphan episodic link repair", () => {
  let writeTool: WriteTool;
  let embedWorker: EmbeddingWorker;
  let consolidation: ConsolidationWorker;

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    container.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });

    embedWorker = container.resolve(EmbeddingWorker);
    consolidation = container.resolve(ConsolidationWorker);
    writeTool = container.resolve(WriteTool);
    edgesRepo = container.resolve(EdgesRepo);
    consolidationRepo = container.resolve(ConsolidationRepo);
  });

  it("should link an unlinked episodic to its nearest semantic neighbor when swept", async () => {
    // Given
    const s = (await sessionStart.invoke({})).session_id;
    const topic = "the http client retries three times with exponential backoff";
    const fact = await newNode(writeTool, s, "Retry budget", topic);
    const orphan = await newEpisodic(writeTool, s, "Touched the retry logic", topic);

    await embedWorker.tick();

    // A checkpoint/event_note written without touched_node_ids has no edges at all.
    expect(edgesRepo.edgesOf(orphan)).toHaveLength(0);

    // When
    const consolidationResult = await consolidation.tick();

    // Then
    expect(consolidationResult.links_added).toBe(1);
    expect(edgeTypesBetween(orphan, fact)).toContain("similar_to");
  });

  it("should re-seed nothing when the episodic already has an edge", async () => {
    // Given
    const s = (await sessionStart.invoke({})).session_id;
    const topic = "the http client retries three times with exponential backoff";
    await newNode(writeTool, s, "Retry budget", topic);
    await newEpisodic(writeTool, s, "Touched the retry logic", topic);
    await embedWorker.tick();

    // When / Then
    expect((await consolidation.tick()).links_added).toBe(1);
    // When / Then
    expect((await consolidation.tick()).links_added).toBe(0);
  });
});
