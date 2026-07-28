import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { ConsolidationWorker } from "@/consolidation/worker";
import type { Envelope } from "@/db/repo";
import { EmbeddingWorker } from "@/embeddings/worker";
import { SessionStartTool } from "../src/tools/session-start";
import { WriteTool } from "../src/tools/write";
import { container } from "tsyringe";
import { CONSOLIDATOR_TOKEN } from "../src/tools/services/consolidation.service";
import { createConsolidator } from "../src/consolidation";
import { EMBEDDING_PROVIDER_TOKEN } from "../src/embeddings";
import { DB_TOKEN } from "../src/db/repositories/base";
import { openDatabase } from "../src/db/database";
import { LocalNullProvider } from "../src/embeddings/local-null";
import { EdgesRepo } from "../src/db/repositories/edges";
import { ConsolidationRepo } from "../src/db/repositories/consolidation";

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
      memory_kind: "semantic",
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
      memory_kind: "episodic",
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

describe("similar_to link discovery", () => {
  let writeTool: WriteTool;
  let embedWorker: EmbeddingWorker;
  let consolidation: ConsolidationWorker;

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });

    embedWorker = container.resolve(EmbeddingWorker);
    consolidation = container.resolve(ConsolidationWorker);
    writeTool = container.resolve(WriteTool);
    edgesRepo = container.resolve(EdgesRepo);
    consolidationRepo = container.resolve(ConsolidationRepo);
  });

  it("auto (default) writes a system similar_to edge between near-identical nodes only", async () => {
    const { twinA, twinB, other } = await seed(writeTool, embedWorker);

    const consolidationResult = await consolidation.tick();
    expect(consolidationResult.links_added).toBe(1);

    expect(edgeTypesBetween(twinA, twinB)).toContain("similar_to");
    expect(edgeTypesBetween(twinA, other)).not.toContain("similar_to");
  });

  it("is idempotent — a second sweep adds no duplicate edge", async () => {
    await seed(writeTool, embedWorker);

    expect((await consolidation.tick()).links_added).toBe(1);
    expect((await consolidation.tick()).links_added).toBe(0);
  });

  it("writes a system-provenance edge that graph expansion can traverse", async () => {
    const { twinA, twinB } = await seed(writeTool, embedWorker);
    await consolidation.tick();

    // neighborsOf is what search uses for 1-hop graph expansion: the discovered
    // similar_to edge makes each twin a neighbor of the other.
    const neighbors = edgesRepo.neighborsOf([twinA]);
    const hit = neighbors.find((n) => n.node.id === twinB);

    expect(hit).toBeDefined();
    expect(hit!.edge).toBe("similar_to");
  });

  it("suggest posture queues a link candidate instead of writing an edge", async () => {
    process.env.MEMORY_CONSOLIDATE_LINKS = "suggest";

    const { twinA, twinB } = await seed(writeTool, embedWorker);

    const consolidationResult = await consolidation.tick();

    expect(consolidationResult.links_suggested).toBe(1);
    expect(consolidationResult.links_added).toBe(0);
    expect(edgeTypesBetween(twinA, twinB)).not.toContain("similar_to");

    const pending = consolidationRepo.pendingCandidates({ kind: "link" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.member_ids.sort()).toEqual([twinA, twinB].sort());
  });

  it("off posture does nothing", async () => {
    process.env.MEMORY_CONSOLIDATE_LINKS = "off";

    await seed(writeTool, embedWorker);
    const consolidationResult = await consolidation.tick();

    expect(consolidationResult).toMatchObject({ links_added: 0, links_suggested: 0 });
  });
});

describe("orphan episodic repair — link discovery reconnects unlinked episodics", () => {
  let writeTool: WriteTool;
  let embedWorker: EmbeddingWorker;
  let consolidation: ConsolidationWorker;

  beforeEach(() => {
    container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });
    container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });

    embedWorker = container.resolve(EmbeddingWorker);
    consolidation = container.resolve(ConsolidationWorker);
    writeTool = container.resolve(WriteTool);
    edgesRepo = container.resolve(EdgesRepo);
    consolidationRepo = container.resolve(ConsolidationRepo);
  });

  it("links an unlinked episodic to its nearest semantic neighbor", async () => {
    const s = (await sessionStart.invoke({})).session_id;
    const topic = "the http client retries three times with exponential backoff";
    const fact = await newNode(writeTool, s, "Retry budget", topic);
    const orphan = await newEpisodic(writeTool, s, "Touched the retry logic", topic);

    await embedWorker.tick();

    // A checkpoint/event_note written without touched_node_ids has no edges at all.
    expect(edgesRepo.edgesOf(orphan)).toHaveLength(0);
    const consolidationResult = await consolidation.tick();

    expect(consolidationResult.links_added).toBe(1);
    expect(edgeTypesBetween(orphan, fact)).toContain("similar_to");
  });

  it("re-seeds nothing once the episodic has an edge (idempotent)", async () => {
    const s = (await sessionStart.invoke({})).session_id;
    const topic = "the http client retries three times with exponential backoff";
    await newNode(writeTool, s, "Retry budget", topic);
    await newEpisodic(writeTool, s, "Touched the retry logic", topic);
    await embedWorker.tick();

    expect((await consolidation.tick()).links_added).toBe(1);
    expect((await consolidation.tick()).links_added).toBe(0);
  });
});
