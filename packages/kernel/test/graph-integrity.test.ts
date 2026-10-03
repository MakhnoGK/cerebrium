import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import { ConsolidationKind, EdgeType, EventAction, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  ConsolidationRecommendation,
  LinkRelation,
  type ConsolidationProvider,
  type RelateResult,
  type RelateTask,
} from "@/domain/ports/consolidation-provider";
import { CONSOLIDATION_REPO_TOKEN, type ConsolidationRepo } from "@/domain/ports/storage";
import { ActivityFeed } from "@/application/services";
import { ConsolidationWorker } from "@/application/workers";
import type { Envelope } from "@/db/repo";
import { ConsolidateApplyTool } from "@/presentation/mcp/tools/consolidate-apply";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { UpdateTool } from "@/presentation/mcp/tools/update";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { ConsolidationPostureConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

const TWIN = "the http client retries three times with exponential backoff";

class FakeRelater implements ConsolidationProvider {
  readonly name = "fake";
  readonly version = "1";
  readonly enabled = true;
  calls: RelateTask[] = [];
  fail = false;

  constructor(public verdict: Partial<RelateResult> = {}) {}

  generate(): never {
    throw new Error("not used");
  }

  reconcile(): never {
    throw new Error("not used");
  }

  annotate(): never {
    throw new Error("not used");
  }

  relate(task: RelateTask): Promise<RelateResult> {
    this.calls.push(task);
    if (this.fail) return Promise.reject(new Error("model down"));
    return Promise.resolve({
      relation: LinkRelation.RELATES_TO,
      from: "a",
      reason: "same retry policy",
      ...this.verdict,
    });
  }
}

let env: TestEnv;
let relater: FakeRelater;
let session: string;

async function write(
  title: string,
  content: string,
  kind = MemoryKind.SEMANTIC,
  type = "fact",
  project?: string,
): Promise<string> {
  return (
    (await container.resolve(WriteTool).invoke({
      session_id: session,
      parent_node_id: null,
      memory_kind: kind,
      type,
      title,
      content,
      project,
    })) as Envelope
  ).id;
}

async function liveEdge(src: string, dst: string, type: EdgeType): Promise<boolean> {
  return (await env.edges.edgesOf(src)).some(
    (e) => e.id === dst && e.edge === (type as string) && e.direction === "out",
  );
}

let consolidation: ConsolidationWorker | null;

// One worker per test: a second instance would find the first one's lease and do nothing.
async function sweep() {
  await env.worker.tick();
  consolidation ??= container.resolve(ConsolidationWorker);
  return consolidation.tick();
}

function posture(extra: Record<string, string> = {}) {
  container.register(ConsolidationPostureConfig, {
    useValue: new ConsolidationPostureConfig(
      new StaticConfigSource({
        MEMORY_CONSOLIDATE_MERGE: "off",
        MEMORY_CONSOLIDATE_DISTILL: "off",
        MEMORY_CONSOLIDATE_ANNOTATE: "off",
        MEMORY_CONSOLIDATE_RECONCILE: "off",
        ...extra,
      }),
    ),
  });
}

async function revise(id: string, times: number) {
  for (let rev = 0; rev < times; rev++) {
    await container.resolve(UpdateTool).invoke({
      session_id: session,
      id,
      content: `${TWIN} (revision ${String(rev)})`,
    });
  }
}

function integrityEvents(heard: ActivityEntry[]) {
  return heard.filter((e) => e.action === (EventAction.GRAPH_INTEGRITY as string));
}

beforeEach(async () => {
  consolidation = null;
  relater = new FakeRelater();
  env = setup({ consolidator: relater });
  posture();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

async function twins(): Promise<[string, string]> {
  const a = await write("Retry budget", TWIN);
  const b = await write("Client retries", TWIN);

  return a < b ? [a, b] : [b, a];
}

describe("Link typing", () => {
  it("should replace a similar_to with the relation the model names", async () => {
    // Given
    const [a, b] = await twins();

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.links_typed).toBe(1);
    expect(await liveEdge(a, b, EdgeType.SIMILAR_TO)).toBe(false);
    expect(await liveEdge(a, b, EdgeType.RELATES_TO)).toBe(true);
    expect((await env.stats.techStats(env.clock.t)).graph.untyped_links).toBe(0);
  });

  it("should record each judgement in the activity log, live and in history", async () => {
    // Given
    const [a, b] = await twins();
    const heard: ActivityEntry[] = [];
    const unlisten = container.resolve(ActivityFeed).listen((e) => heard.push(e));

    // When
    await sweep();
    unlisten();

    // Then
    const logged = (await env.sessions.recentEvents(50, null)).filter(
      (e) => e.action === (EventAction.GRAPH_INTEGRITY as string),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      node_id: a,
      detail: { op: "retype", relation: LinkRelation.RELATES_TO, to: b },
    });
    expect(heard.filter((e) => e.action === (EventAction.GRAPH_INTEGRITY as string))).toHaveLength(
      1,
    );
  });

  it("should point a references edge from the record the model names as the source", async () => {
    // Given
    const [a, b] = await twins();
    relater.verdict = { relation: LinkRelation.REFERENCES, from: "b" };

    // When
    await sweep();

    // Then
    expect(await liveEdge(b, a, EdgeType.REFERENCES)).toBe(true);
    expect(await liveEdge(a, b, EdgeType.REFERENCES)).toBe(false);
  });

  it("should drop the link for good when the model finds no relation", async () => {
    // Given
    const [a, b] = await twins();
    relater.verdict = { relation: LinkRelation.NONE };

    // When
    const first = await sweep();
    const second = await sweep();

    // Then
    expect(first.integrity?.links_dropped).toBe(1);
    expect(second.links_added).toBe(0);
    expect(await env.edges.pairIsConnected(a, b)).toBe(false);
  });

  it("should send a duplicate to review and keep the pair related meanwhile", async () => {
    // Given
    const [a, b] = await twins();
    relater.verdict = { relation: LinkRelation.DUPLICATE_OF, from: "a" };

    // When
    const result = await sweep();

    // Then
    const [cand] = await env.consolidation.pendingCandidates({ kind: ConsolidationKind.MERGE });
    expect(result.integrity?.links_to_review).toBe(1);
    expect(cand?.member_ids).toEqual([a, b]);
    expect(cand?.canonical_id).toBe(b);
    expect(await liveEdge(a, b, EdgeType.RELATES_TO)).toBe(true);
  });

  it("should retire the older note at once when the model finds it superseded", async () => {
    // Given
    const [a, b] = await twins();
    relater.verdict = { relation: LinkRelation.SUPERSEDES, from: "b" };
    const heard: ActivityEntry[] = [];
    const unlisten = container.resolve(ActivityFeed).listen((e) => heard.push(e));

    // When
    const result = await sweep();
    unlisten();

    // Then
    expect(result.integrity?.superseded).toBe(1);
    expect((await env.nodes.envelope(a))?.invalidated).toBe(true);
    expect(await liveEdge(b, a, EdgeType.SUPERSEDES)).toBe(true);
    expect(
      await env.consolidation.pendingCandidates({ kind: ConsolidationKind.SUPERSEDE }),
    ).toHaveLength(0);
    expect(integrityEvents(heard).find((e) => e.node_id === a)?.detail).toMatchObject({
      op: "supersede",
      to: b,
    });
  });

  it("should keep a hand-maintained note the model finds superseded", async () => {
    // Given
    const [a, b] = await twins();
    await revise(a, 4);
    relater.verdict = { relation: LinkRelation.SUPERSEDES, from: "b" };
    const heard: ActivityEntry[] = [];
    const unlisten = container.resolve(ActivityFeed).listen((e) => heard.push(e));

    // When
    const result = await sweep();
    unlisten();

    // Then
    expect(result.integrity?.superseded ?? 0).toBe(0);
    expect((await env.nodes.envelope(a))?.invalidated).toBe(false);
    expect(await liveEdge(a, b, EdgeType.RELATES_TO)).toBe(true);
    expect(
      await env.consolidation.pendingCandidates({ kind: ConsolidationKind.SUPERSEDE }),
    ).toHaveLength(0);
    expect(integrityEvents(heard).find((e) => e.node_id === a)?.detail).toMatchObject({
      op: "supersede",
      kept: "hand-maintained",
      revisions: 5,
    });
  });

  it("should settle a supersede candidate queued before the posture was auto", async () => {
    // Given
    const [a, b] = await twins();
    const id = await env.consolidation.insertCandidate({
      kind: ConsolidationKind.SUPERSEDE,
      member_ids: [a, b],
      canonical_id: b,
      score: 1,
      detected_at: env.clock.t,
    });

    // When
    await sweep();

    // Then
    expect((await env.consolidation.getCandidate(id!))?.status).toBe("applied");
    expect((await env.nodes.envelope(a))?.invalidated).toBe(true);
  });

  it("should queue a supersede for review under the suggest posture", async () => {
    // Given
    posture({ MEMORY_CONSOLIDATE_SUPERSEDE: "suggest" });
    const [a, b] = await twins();
    relater.verdict = { relation: LinkRelation.SUPERSEDES, from: "b" };
    await sweep();
    const [cand] = await env.consolidation.pendingCandidates({
      kind: ConsolidationKind.SUPERSEDE,
    });
    expect((await env.nodes.envelope(a))?.invalidated).toBe(false);

    // When
    await container.resolve(ConsolidateApplyTool).invoke({
      session_id: session,
      id: cand!.id,
      decision: ConsolidationRecommendation.APPLY,
    });

    // Then
    expect(cand?.member_ids).toEqual([a, b]);
    expect((await env.nodes.envelope(a))?.invalidated).toBe(true);
    expect(await liveEdge(b, a, EdgeType.SUPERSEDES)).toBe(true);
  });

  it("should drop a similar_to between a pair another edge already joins, without the model", async () => {
    // Given
    const [a, b] = await twins();
    await container
      .resolve(LinkTool)
      .invoke({ session_id: session, src: a, dst: b, type: EdgeType.REFERENCES });

    // When
    const result = await sweep();

    // Then
    expect(relater.calls).toHaveLength(0);
    expect(result.integrity?.links_dropped).toBe(1);
    expect(await liveEdge(a, b, EdgeType.REFERENCES)).toBe(true);
  });

  it("should report generative work while an untyped link is left", async () => {
    // Given
    await twins();
    await env.worker.tick();
    const worker = container.resolve(ConsolidationWorker);
    relater.fail = true;
    const failed = await worker.tick();

    // When / Then
    expect(failed.generation_failures).toBeGreaterThan(0);
    expect(await worker.hasGenerativeWork()).toBe(true);
    relater.fail = false;
    await worker.tick();
    expect(await worker.hasGenerativeWork()).toBe(false);
  });
});

describe("Reattach", () => {
  it("should attach an edgeless record to its session's checkpoint", async () => {
    // Given
    const checkpoint = await write(
      "Block closed",
      "the deploy block closed cleanly",
      MemoryKind.EPISODIC,
      "checkpoint",
    );
    const record = await write(
      "agent.selftest run completed",
      "zebra quartz violin",
      MemoryKind.EPISODIC,
      "event_note",
    );

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.reattached).toBeGreaterThanOrEqual(1);
    expect(await liveEdge(record, checkpoint, EdgeType.RELATES_TO)).toBe(true);
  });

  it("should attach an edgeless note to the nearest note the model relates it to", async () => {
    // Given
    const lonely = await write("OpenRouter retention", "openrouter keeps prompts for thirty days");
    const other = await write("LLM gateway", "calls go through openrouter rather than openai");

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.reattached).toBeGreaterThanOrEqual(1);
    expect(await env.edges.pairIsConnected(lonely, other)).toBe(true);
    expect((await env.stats.techStats(env.clock.t)).graph.edgeless_nodes).toBe(0);
  });

  it("should not ask again about a note the model related to nothing", async () => {
    // Given
    await write("OpenRouter retention", "openrouter keeps prompts for thirty days");
    await write("LLM gateway", "calls go through openrouter rather than openai");
    relater.verdict = { relation: LinkRelation.NONE };
    await sweep();
    const asked = relater.calls.length;

    // When
    await sweep();

    // Then
    expect(asked).toBeGreaterThan(0);
    expect(relater.calls.length).toBe(asked);
  });
});

describe("Project families", () => {
  it("should link twins within a project family and not across families", async () => {
    // Given
    const cerebrium = await write("Retry budget", TWIN, MemoryKind.SEMANTIC, "fact", "cerebrium");
    const toonspace = await write("Client retries", TWIN, MemoryKind.SEMANTIC, "fact", "toonspace");
    const builder = await write(
      "Builder retries",
      TWIN,
      MemoryKind.SEMANTIC,
      "fact",
      "toonspace-builder",
    );

    // When
    await sweep();

    // Then
    expect(await env.edges.pairIsConnected(toonspace, builder)).toBe(true);
    expect(await env.edges.pairIsConnected(cerebrium, toonspace)).toBe(false);
    expect(await env.edges.pairIsConnected(cerebrium, builder)).toBe(false);
  });

  it("should drop a system link across families and keep an authored one", async () => {
    // Given
    const a = await write("Retry budget", TWIN, MemoryKind.SEMANTIC, "fact", "cerebrium");
    const b = await write(
      "Episode purchase",
      "coins buy an episode",
      MemoryKind.SEMANTIC,
      "fact",
      "toonspace-builder",
    );
    const c = await write(
      "Host migration",
      "only two projects move",
      MemoryKind.SEMANTIC,
      "fact",
      "toonspace",
    );
    await env.edges.insertSystemEdgeIfUnconnected(
      EdgeType.RELATES_TO,
      a,
      b,
      session,
      env.clock.t,
      0.8,
    );
    await container
      .resolve(LinkTool)
      .invoke({ session_id: session, src: a, dst: c, type: EdgeType.REFERENCES });

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.links_dropped).toBeGreaterThanOrEqual(1);
    expect(await liveEdge(a, b, EdgeType.RELATES_TO)).toBe(false);
    expect(await liveEdge(a, c, EdgeType.REFERENCES)).toBe(true);
    const logged = (await env.sessions.recentEvents(50, null)).filter(
      (e) => e.action === (EventAction.GRAPH_INTEGRITY as string),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({
        node_id: a,
        detail: { op: "drop", relation: EdgeType.RELATES_TO, to: b, via: "cross-project" },
      }),
    );
  });

  it("should not anchor a record to its session's checkpoint from another family", async () => {
    // Given
    const checkpoint = await write(
      "Block closed",
      "the deploy block closed cleanly",
      MemoryKind.EPISODIC,
      "checkpoint",
      "toonspace",
    );
    const record = await write(
      "agent.selftest run completed",
      "zebra quartz violin",
      MemoryKind.EPISODIC,
      "event_note",
      "cerebrium",
    );

    // When
    await sweep();

    // Then
    expect(await env.edges.pairIsConnected(record, checkpoint)).toBe(false);
  });
});

describe("Recheck after a revision", () => {
  it("should drop a typed link the model no longer sees once a note was revised", async () => {
    // Given
    const [a, b] = await twins();
    await sweep();
    env.clock.advanceMs(1_000);
    await revise(a, 1);
    relater.verdict = { relation: LinkRelation.NONE };

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.links_dropped).toBeGreaterThanOrEqual(1);
    expect(await liveEdge(a, b, EdgeType.RELATES_TO)).toBe(false);
  });

  it("should keep a link the model still sees and not ask about it again", async () => {
    // Given
    const [a, b] = await twins();
    await sweep();
    env.clock.advanceMs(1_000);
    await revise(a, 1);
    const before = relater.calls.length;

    // When
    await sweep();
    const asked = relater.calls.length;
    await sweep();

    // Then
    expect(asked).toBe(before + 1);
    expect(await liveEdge(a, b, EdgeType.RELATES_TO)).toBe(true);
    expect(relater.calls.length).toBe(asked);
  });

  it("should keep a references link the source still states as a wikilink, without the model", async () => {
    // Given
    const target = await write("Kafka", "ingestion consumes kafka topics by tenant");
    const source = await write("Plan", "builds on [[Kafka]]");
    await sweep();
    env.clock.advanceMs(1_000);
    await container
      .resolve(UpdateTool)
      .invoke({ session_id: session, id: source, content: "builds on [[Kafka]] and retries" });
    const asked = relater.calls.length;

    // When
    await sweep();

    // Then
    expect(await liveEdge(source, target, EdgeType.REFERENCES)).toBe(true);
    expect(relater.calls.length).toBe(asked);
    expect(
      await container.resolve<ConsolidationRepo>(CONSOLIDATION_REPO_TOKEN).revisedLinks(10),
    ).toEqual([]);
  });
});

describe("Wikilinks by id", () => {
  it("should link a note to the node its prose names by id, following a supersede", async () => {
    // Given
    const old = await write("Retry budget", "the http client retries with a budget of three");
    const successor = await write("Retry budget v2", "the client now retries five times");
    await container.resolve(InvalidateTool).invoke({
      session_id: session,
      id: old,
      superseded_by: successor,
      reason: "replaced",
    });
    const live = await write("Kafka", "ingestion consumes kafka topics by tenant");
    const source = await write("Plan", `builds on [[${old}]] and on [[${live}]]`);

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.wikilinks_by_id).toBe(2);
    expect(await liveEdge(source, successor, EdgeType.REFERENCES)).toBe(true);
    expect(await liveEdge(source, live, EdgeType.REFERENCES)).toBe(true);
  });

  it("should count an id that names no node", async () => {
    // Given
    await write("Plan", `builds on [[01M3${"Z".repeat(22)}]]`);

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.wikilinks_dangling_id).toBe(1);
    expect(result.wikilinks_dangling).toBe(0);
  });
});

describe("Stranded system edges", () => {
  it("should move a system edge into a superseded node onto its successor", async () => {
    // Given
    const referrer = await write("Kafka", "ingestion consumes kafka topics by tenant");
    const old = await write("Retry budget", "the http client retries with a budget of three");
    const successor = await write("Retry budget v2", "the client now retries five times");
    await env.edges.insertSystemEdgeIfUnconnected(
      EdgeType.RELATES_TO,
      referrer,
      old,
      session,
      env.clock.t,
      0.8,
    );
    await container.resolve(InvalidateTool).invoke({
      session_id: session,
      id: old,
      superseded_by: successor,
      reason: "replaced",
    });

    // When
    const result = await sweep();

    // Then
    expect(result.integrity?.edges_repointed).toBe(1);
    expect(await liveEdge(referrer, successor, EdgeType.RELATES_TO)).toBe(true);
    expect(await liveEdge(referrer, old, EdgeType.RELATES_TO)).toBe(false);
  });
});

describe("Collapse guard", () => {
  it("should refuse to collapse a merge into a hand-maintained note", async () => {
    // Given
    const [a, b] = await twins();
    await revise(b, 4);
    const id = await env.consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [a, b],
      canonical_id: b,
      score: 1,
      detected_at: env.clock.t,
    });

    // When
    const collapse = container.resolve(ConsolidateApplyTool).invoke({
      session_id: session,
      id: id!,
      decision: ConsolidationRecommendation.APPLY,
      collapse: true,
      override: { title: "Retries", summary: "Retries.", body: "Retries." },
    });

    // Then
    await expect(collapse).rejects.toThrow(/hand-maintained.*mark it duplicate/);
    expect((await env.nodes.envelope(a))?.invalidated).toBe(false);
    expect((await env.consolidation.getCandidate(id!))?.status).toBe("pending");
  });
});
