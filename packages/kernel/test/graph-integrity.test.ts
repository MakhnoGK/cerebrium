import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { ConsolidationKind, EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  ConsolidationRecommendation,
  LinkRelation,
  type ConsolidationProvider,
  type RelateResult,
  type RelateTask,
} from "@/domain/ports/consolidation-provider";
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
): Promise<string> {
  return (
    (await container.resolve(WriteTool).invoke({
      session_id: session,
      parent_node_id: null,
      memory_kind: kind,
      type,
      title,
      content,
    })) as Envelope
  ).id;
}

async function liveEdge(src: string, dst: string, type: EdgeType): Promise<boolean> {
  return (await env.edges.edgesOf(src)).some(
    (e) => e.id === dst && e.edge === (type as string) && e.direction === "out",
  );
}

async function sweep() {
  await env.worker.tick();
  return container.resolve(ConsolidationWorker).tick();
}

beforeEach(async () => {
  relater = new FakeRelater();
  env = setup({ consolidator: relater });
  container.register(ConsolidationPostureConfig, {
    useValue: new ConsolidationPostureConfig(
      new StaticConfigSource({
        MEMORY_CONSOLIDATE_MERGE: "off",
        MEMORY_CONSOLIDATE_DISTILL: "off",
        MEMORY_CONSOLIDATE_ANNOTATE: "off",
        MEMORY_CONSOLIDATE_RECONCILE: "off",
      }),
    ),
  });
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

  it("should retire the older note only once a supersede is applied", async () => {
    // Given
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
    for (let rev = 0; rev < 4; rev++) {
      await container.resolve(UpdateTool).invoke({
        session_id: session,
        id: b,
        content: `${TWIN} (revision ${String(rev)})`,
      });
    }
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
    await expect(collapse).rejects.toThrow(/hand-maintained/);
    expect((await env.nodes.envelope(a))?.invalidated).toBe(false);
    expect((await env.consolidation.getCandidate(id!))?.status).toBe("pending");
  });
});
