import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActivityEntry } from "@cerebrium/contracts/dashboard";
import { EdgeType, EventAction, MemoryKind } from "@cerebrium/contracts/vocab";
import type { WikilinkDangler } from "@cerebrium/contracts/wikilinks";
import {
  LinkConfidence,
  type ConsolidationProvider,
  type ResolveLinkResult,
  type ResolveLinkTask,
} from "@/domain/ports/consolidation-provider";
import { CallPipeline } from "@/application/call-pipeline";
import { ActivityFeed } from "@/application/services";
import { ConsolidationWorker } from "@/application/workers";
import { parseResolveLink, resolveLinkSchema } from "@/consolidation/provider";
import { ConsolidationPostureConfig, StaticConfigSource } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

class FakeResolver implements ConsolidationProvider {
  readonly name = "fake";
  readonly version = "1";
  readonly enabled = true;
  tasks: ResolveLinkTask[] = [];

  constructor(public pick: (task: ResolveLinkTask) => ResolveLinkResult) {}

  generate(): never {
    throw new Error("not used");
  }

  reconcile(): never {
    throw new Error("not used");
  }

  annotate(): never {
    throw new Error("not used");
  }

  relate(): never {
    throw new Error("not used");
  }

  resolveLink(task: ResolveLinkTask): Promise<ResolveLinkResult> {
    this.tasks.push(task);
    return Promise.resolve(this.pick(task));
  }
}

function titled(title: string, confidence = LinkConfidence.HIGH) {
  return (task: ResolveLinkTask): ResolveLinkResult => ({
    target_id: task.candidates.find((c) => c.title === title)?.id ?? null,
    confidence,
    reason: "the link names it",
  });
}

let env: TestEnv;
let resolver: FakeResolver;
let session: string;
let worker: ConsolidationWorker | null;

function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return container.resolve(CallPipeline).invoke(container, name, args, {
    client: "cerebrium-dashboard",
    version: null,
  }) as Promise<T>;
}

async function note(title: string, content: string, kind = MemoryKind.SEMANTIC): Promise<string> {
  const written = await call<{ envelope: { id: string } }>("write_memory", {
    session_id: session,
    parent_node_id: null,
    memory_kind: kind,
    type: kind === MemoryKind.SEMANTIC ? "fact" : "event_note",
    title,
    content,
    project: "cerebrium",
  });

  return written.envelope.id;
}

async function body(id: string): Promise<string> {
  return (await env.nodes.stateAt(id, "9999-12-31T00:00:00.000Z"))!.content;
}

function danglers(): Promise<WikilinkDangler[]> {
  return call("list_danglers", {});
}

function posture(wikilinks = "auto") {
  container.register(ConsolidationPostureConfig, {
    useValue: new ConsolidationPostureConfig(
      new StaticConfigSource({
        MEMORY_CONSOLIDATE_MERGE: "off",
        MEMORY_CONSOLIDATE_DISTILL: "off",
        MEMORY_CONSOLIDATE_ANNOTATE: "off",
        MEMORY_CONSOLIDATE_RECONCILE: "off",
        MEMORY_CONSOLIDATE_REATTACH: "off",
        MEMORY_CONSOLIDATE_RETYPE: "off",
        MEMORY_CONSOLIDATE_WIKILINKS: wikilinks,
      }),
    ),
  });
}

// One worker per test: a second instance would find the first one's lease and do nothing.
async function sweep() {
  await env.worker.tick();
  worker ??= container.resolve(ConsolidationWorker);
  return worker.tick();
}

beforeEach(async () => {
  worker = null;
  resolver = new FakeResolver(titled("Episode purchase flow"));
  env = setup({ consolidator: resolver });
  posture();
  session = (await call<{ session_id: string }>("start_session", {})).session_id;
});

describe("Resolving dangling wikilinks in the sweep", () => {
  it("should rewrite a link to the note the model picks with confidence", async () => {
    // Given
    const target = await note("Episode purchase flow", "buying an episode works with coins");
    const source = await note("Shop notes", "see [[How buying works]] for detail");
    const heard: ActivityEntry[] = [];
    const unlisten = container.resolve(ActivityFeed).listen((e) => heard.push(e));

    // When
    const result = await sweep();
    unlisten();

    // Then
    expect(resolver.tasks[0]).toMatchObject({
      link: "How buying works",
      note: { title: "Shop notes", context: "see [[How buying works]] for detail" },
    });
    expect(await body(source)).toBe(`see [[${target}]] for detail`);
    expect((await env.nodes.listRevisions(source)).at(-1)?.reason).toBe(
      `wikilink [[How buying works]] -> [[${target}]] (sweep)`,
    );
    expect(result.integrity?.wikilinks_fixed).toBe(1);
    expect(await danglers()).toEqual([]);
    expect(
      heard.find((e) => e.action === (EventAction.GRAPH_INTEGRITY as string))?.detail,
    ).toMatchObject({ op: "wikilink", relation: "rewrite", to: target });
  });

  it("should unlink a link the model confidently matches to no note", async () => {
    // Given
    resolver.pick = () => ({
      target_id: null,
      confidence: LinkConfidence.HIGH,
      reason: "no candidate is about refunds",
    });
    await note("Episode purchase flow", "buying an episode works with coins");
    const source = await note("Shop notes", "see [[How buying works]] for detail");

    // When
    const result = await sweep();

    // Then
    expect(await body(source)).toBe("see How buying works for detail");
    expect(result.integrity?.wikilinks_unlinked).toBe(1);
  });

  it("should leave an unsure pick for review with the model's choice", async () => {
    // Given
    resolver.pick = titled("Episode purchase flow", LinkConfidence.LOW);
    const target = await note("Episode purchase flow", "buying an episode works with coins");
    const source = await note("Shop notes", "see [[How buying works]] for detail");

    // When
    const result = await sweep();

    // Then
    expect(await body(source)).toBe("see [[How buying works]] for detail");
    expect(result.integrity?.wikilinks_to_review).toBe(1);
    expect((await danglers())[0]?.verdict).toMatchObject({
      target: { id: target, title: "Episode purchase flow" },
      confidence: "low",
      reason: "the link names it",
    });
  });

  it("should not ask again about a link judged on the note's current revision", async () => {
    // Given
    resolver.pick = titled("Episode purchase flow", LinkConfidence.LOW);
    await note("Episode purchase flow", "buying an episode works with coins");
    await note("Shop notes", "see [[How buying works]] for detail");
    await sweep();

    // When
    await sweep();

    // Then
    expect(resolver.tasks).toHaveLength(1);
  });

  it("should link and ignore a dangling link in an episodic note", async () => {
    // Given
    const target = await note("Episode purchase flow", "buying an episode works with coins");
    const source = await note(
      "Shop session",
      "looked at [[How buying works]] today",
      MemoryKind.EPISODIC,
    );

    // When
    const result = await sweep();

    // Then
    expect(await body(source)).toBe("looked at [[How buying works]] today");
    expect(
      (await env.edges.edgesOf(source)).some(
        (e) => e.id === target && e.edge === (EdgeType.REFERENCES as string),
      ),
    ).toBe(true);
    expect(result.integrity?.wikilinks_fixed).toBe(1);
    expect(await danglers()).toEqual([]);
  });

  it("should only record the model's picks under suggest", async () => {
    // Given
    posture("suggest");
    const target = await note("Episode purchase flow", "buying an episode works with coins");
    const source = await note("Shop notes", "see [[How buying works]] for detail");

    // When
    await sweep();

    // Then
    expect(await body(source)).toBe("see [[How buying works]] for detail");
    expect((await danglers())[0]?.verdict?.target?.id).toBe(target);
  });
});

describe("Rewriting a wikilink", () => {
  async function linkedPair(): Promise<[string, string]> {
    const a = await note("Episode purchase flow", "buying an episode works with coins");
    const b = await note("Shop notes", "see [[How buying works]] for detail");
    await env.edges.insertSystemEdgeIfUnconnected(
      EdgeType.RELATES_TO,
      b,
      a,
      session,
      env.clock.now(),
      1,
    );
    env.clock.advanceMs(1_000);

    return [a, b];
  }

  it("should not queue the note's settled links for a re-check", async () => {
    // Given
    const [, b] = await linkedPair();

    // When
    await call("fix_wikilink", {
      session_id: session,
      node_id: b,
      link: "How buying works",
      action: "unlink",
    });

    // Then
    expect(await env.consolidation.revisedLinks(10)).toEqual([]);
  });

  it("should still queue them after an ordinary revision", async () => {
    // Given
    const [, b] = await linkedPair();

    // When
    await call("update_memory", { session_id: session, id: b, content: "a different fact" });

    // Then
    expect(await env.consolidation.revisedLinks(10)).toHaveLength(1);
  });
});

describe("The resolve-link reply", () => {
  const task: ResolveLinkTask = {
    project: null,
    link: "How buying works",
    note: { title: "Shop notes", context: "see [[How buying works]]" },
    candidates: [{ id: "A", title: "Episode purchase flow", type: "fact", content: "coins" }],
  };

  it("should offer only the candidates' ids and none", () => {
    expect(resolveLinkSchema(task).properties.target.enum).toEqual(["A", "none"]);
  });

  it("should reject a target outside the candidates", () => {
    expect(() => parseResolveLink('{"target":"B","confidence":"high","reason":"x"}', task)).toThrow(
      /outside the candidates/,
    );
  });

  it("should read none as no target and an unknown confidence as low", () => {
    expect(parseResolveLink('{"target":"none","confidence":"sure","reason":"x"}', task)).toEqual({
      target_id: null,
      confidence: LinkConfidence.LOW,
      reason: "x",
    });
  });
});
