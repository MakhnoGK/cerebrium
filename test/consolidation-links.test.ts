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
import { ConsolidationKind, EdgeType, MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { createConsolidator } from "@/consolidation";
import {
  ConsolidationPostureConfig,
  ConsolidationThresholdsConfig,
  StaticConfigSource,
} from "@/infrastructure/config";

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

// Sections are transient, so overriding one in the container is how a test pins a
// posture — no global env mutation, and it works regardless of resolution order.
function postureWith(env: Record<string, string>): ConsolidationPostureConfig {
  return new ConsolidationPostureConfig(new StaticConfigSource(env));
}

function thresholdsWith(env: Record<string, string>): ConsolidationThresholdsConfig {
  return new ConsolidationThresholdsConfig(new StaticConfigSource(env));
}

function liveSimilarDegree(id: string): number {
  return edgesRepo.edgesOf(id).filter((e) => e.edge === "similar_to").length;
}

function edgeTypesBetween(a: string, b: string): string[] {
  return edgesRepo
    .edgesOf(a)
    .filter((e) => e.id === b)
    .map((e) => e.edge);
}

afterEach(() => {
  // A section override is a container registration, so it outlives the test that set it.
  container.register(ConsolidationPostureConfig, { useValue: postureWith({}) });
  container.register(ConsolidationThresholdsConfig, { useValue: thresholdsWith({}) });
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
    container.register(ConsolidationPostureConfig, {
      useValue: postureWith({ MEMORY_CONSOLIDATE_LINKS: "suggest" }),
    });
    consolidation = container.resolve(ConsolidationWorker);
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
    container.register(ConsolidationPostureConfig, {
      useValue: postureWith({ MEMORY_CONSOLIDATE_LINKS: "off" }),
    });
    consolidation = container.resolve(ConsolidationWorker);
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

describe("Link degree cap", () => {
  let writeTool: WriteTool;
  let embedWorker: EmbeddingWorker;
  let consolidation: ConsolidationWorker;

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    container.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });
    container.register(ConsolidationThresholdsConfig, {
      useValue: thresholdsWith({ MEMORY_CONSOLIDATE_MAX_LINK_DEGREE: "2" }),
    });

    embedWorker = container.resolve(EmbeddingWorker);
    consolidation = container.resolve(ConsolidationWorker);
    writeTool = container.resolve(WriteTool);
    edgesRepo = container.resolve(EdgesRepo);
    consolidationRepo = container.resolve(ConsolidationRepo);
  });

  // Identical content -> identical local-null vectors, so every pair clears the gate and
  // only the cap decides how many edges a node ends up with.
  async function quadruplets(): Promise<string[]> {
    const s = (await sessionStart.invoke({})).session_id;
    const dup = "the http client retries three times with exponential backoff";
    const ids = [
      await newNode(writeTool, s, "Retry budget", dup),
      await newNode(writeTool, s, "Client retries", dup),
      await newNode(writeTool, s, "Backoff policy", dup),
      await newNode(writeTool, s, "Retry ceiling", dup),
    ];
    await embedWorker.tick();

    return ids;
  }

  it("should stop adding similar_to edges to a node once it reaches the degree cap", async () => {
    // Given
    const ids = await quadruplets();

    // When
    await consolidation.tick();

    // Then
    for (const id of ids) {
      expect(liveSimilarDegree(id)).toBeLessThanOrEqual(2);
    }
  });

  it("should propose nothing further when a later sweep revisits capped nodes", async () => {
    // Given
    await quadruplets();
    const first = await consolidation.tick();

    // When
    const second = await consolidation.tick();

    // Then
    expect(first.links_added).toBeGreaterThan(0);
    expect(second).toMatchObject({ links_added: 0, links_suggested: 0, links_pruned: 0 });
  });
});

describe("Similar link prune", () => {
  let writeTool: WriteTool;
  let consolidation: ConsolidationWorker;
  let session: string;

  beforeEach(async () => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    container.register(CONSOLIDATION_PROVIDER_TOKEN, { useValue: createConsolidator() });
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });
    // Discovery off: these tests seed the graph by hand so the prune rule is the only
    // thing under test.
    container.register(ConsolidationPostureConfig, {
      useValue: postureWith({ MEMORY_CONSOLIDATE_LINKS: "off" }),
    });
    container.register(ConsolidationThresholdsConfig, {
      useValue: thresholdsWith({ MEMORY_CONSOLIDATE_MAX_LINK_DEGREE: "2" }),
    });

    consolidation = container.resolve(ConsolidationWorker);
    writeTool = container.resolve(WriteTool);
    edgesRepo = container.resolve(EdgesRepo);
    session = (await sessionStart.invoke({})).session_id;
  });

  function seedEdge(src: string, dst: string, weight: number): void {
    edgesRepo.insertEdge(
      src,
      dst,
      EdgeType.SIMILAR_TO,
      "system",
      session,
      "2026-01-01T00:00:00.000Z",
      weight,
    );
  }

  it("should retire only the edge outside the top-2 of both its endpoints when a clique is over cap", async () => {
    // Given
    const [a, b, c, d] = await Promise.all([
      newNode(writeTool, session, "A", "alpha"),
      newNode(writeTool, session, "B", "beta"),
      newNode(writeTool, session, "C", "gamma"),
      newNode(writeTool, session, "D", "delta"),
    ]);
    seedEdge(a, b, 0.99);
    seedEdge(a, c, 0.98);
    seedEdge(a, d, 0.97);
    seedEdge(b, c, 0.96);
    seedEdge(b, d, 0.95);
    seedEdge(c, d, 0.94);

    // When
    const result = await consolidation.tick();

    // Then
    // c-d is the only pair ranking third for both endpoints; every other edge is in
    // someone's top two.
    expect(result.links_pruned).toBe(1);
    expect(edgeTypesBetween(c, d)).not.toContain("similar_to");
    expect(edgeTypesBetween(a, b)).toContain("similar_to");
    expect(edgeTypesBetween(b, d)).toContain("similar_to");
  });

  it("should keep every edge when each endpoint's only anchor would be cut", async () => {
    // Given
    const hub = await newNode(writeTool, session, "Hub", "hub");
    const leaves = [
      await newNode(writeTool, session, "L1", "one"),
      await newNode(writeTool, session, "L2", "two"),
      await newNode(writeTool, session, "L3", "three"),
      await newNode(writeTool, session, "L4", "four"),
    ];
    leaves.forEach((leaf, i) => {
      seedEdge(hub, leaf, 0.99 - i / 100);
    });

    // When
    const result = await consolidation.tick();

    // Then
    expect(result.links_pruned).toBe(0);
    for (const leaf of leaves) {
      expect(liveSimilarDegree(leaf)).toBe(1);
    }
  });

  it("should leave agent-authored and non-similar edges untouched when pruning", async () => {
    // Given
    const [a, b, c, d] = await Promise.all([
      newNode(writeTool, session, "A", "alpha"),
      newNode(writeTool, session, "B", "beta"),
      newNode(writeTool, session, "C", "gamma"),
      newNode(writeTool, session, "D", "delta"),
    ]);
    seedEdge(a, b, 0.99);
    seedEdge(a, c, 0.98);
    seedEdge(a, d, 0.97);
    seedEdge(b, c, 0.96);
    seedEdge(b, d, 0.95);
    edgesRepo.insertEdge(
      c,
      d,
      EdgeType.REFERENCES,
      "agent",
      session,
      "2026-01-01T00:00:00.000Z",
      0.5,
    );

    // When
    await consolidation.tick();

    // Then
    expect(edgeTypesBetween(c, d)).toContain("references");
  });

  it("should do nothing when linkPrune posture is off", async () => {
    // Given
    container.register(ConsolidationPostureConfig, {
      useValue: postureWith({
        MEMORY_CONSOLIDATE_LINKS: "off",
        MEMORY_CONSOLIDATE_LINK_PRUNE: "off",
      }),
    });
    consolidation = container.resolve(ConsolidationWorker);
    const [a, b, c, d] = await Promise.all([
      newNode(writeTool, session, "A", "alpha"),
      newNode(writeTool, session, "B", "beta"),
      newNode(writeTool, session, "C", "gamma"),
      newNode(writeTool, session, "D", "delta"),
    ]);
    seedEdge(a, b, 0.99);
    seedEdge(a, c, 0.98);
    seedEdge(a, d, 0.97);
    seedEdge(b, c, 0.96);
    seedEdge(b, d, 0.95);
    seedEdge(c, d, 0.94);

    // When
    const result = await consolidation.tick();

    // Then
    expect(result.links_pruned).toBe(0);
    expect(edgeTypesBetween(c, d)).toContain("similar_to");
  });
});
