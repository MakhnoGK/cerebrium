import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { ConsolidationWorker } from "@/application/workers";
import { EdgesRepo, NodesRepo } from "@/db/repositories";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { InvalidateTool } from "@/presentation/mcp/tools/invalidate";
import { LinkTool } from "@/presentation/mcp/tools/link";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let session: string;

async function write(title: string, content: string): Promise<string> {
  const { id } = await container.resolve(WriteTool).invoke({
    session_id: session,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content,
  });

  return id;
}

function edgeBetween(src: string, dst: string): { type: string; provenance: string } | undefined {
  return env.db
    .prepare(
      "SELECT type, provenance FROM edges WHERE src = ? AND dst = ? AND invalidated_at IS NULL",
    )
    .get(src, dst) as { type: string; provenance: string } | undefined;
}

beforeEach(async () => {
  env = setup();
  session = (await container.resolve(SessionStartTool).invoke({})).session_id;
});

describe("Wikilinks as edges", () => {
  it("should link a node to the one its prose names", async () => {
    // Given
    const target = await write("Retry budget", "the http client retries with a budget of three");
    const source = await write(
      "Deploy pipeline",
      "the pipeline honours [[retry-budget]] when a stage fails and needs another attempt",
    );

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.wikilinks_linked).toBeGreaterThanOrEqual(1);
    expect(edgeBetween(source, target)).toEqual({
      type: EdgeType.REFERENCES,
      provenance: "system",
    });
  });

  it("should accept a truncated slug when only one node can be meant", async () => {
    // Given
    const target = await write(
      "MEASURED 2026-08-21: the sweep costs 29.7s and changes nothing in most runs",
      "the consolidation sweep was measured against the live store over many runs",
    );
    const source = await write("Sweep plan", "acting on [[measured-2026-08-21-the-sweep-costs]]");

    // When
    await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(edgeBetween(source, target)?.type).toBe(EdgeType.REFERENCES);
  });

  it("should count a target that does not exist instead of inventing an edge", async () => {
    // Given
    await write("Lonely note", "this refers to [[a-node-nobody-ever-wrote]] and stops there");

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.wikilinks_dangling).toBeGreaterThanOrEqual(1);
    expect(result.wikilinks_linked).toBe(0);
  });

  it("should leave a pair that is already connected alone, whatever the edge type", async () => {
    // Given — the prose states a `references`, the graph already has a `relates_to`
    const target = await write("Retry budget", "the http client retries with a budget of three");
    const source = await write("Deploy pipeline", "the pipeline honours [[retry-budget]] on fail");

    await container.resolve(LinkTool).invoke({
      session_id: session,
      src: source,
      dst: target,
      type: EdgeType.RELATES_TO,
    });

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.wikilinks_linked).toBe(0);
    expect(edgeBetween(source, target)).toEqual({
      type: EdgeType.RELATES_TO,
      provenance: "agent",
    });
  });

  it("should never overwrite the provenance of an edge somebody authored", async () => {
    // Given
    const target = await write("Retry budget", "the http client retries with a budget of three");
    const source = await write("Deploy pipeline", "the pipeline honours [[retry-budget]] on fail");

    await container.resolve(LinkTool).invoke({
      session_id: session,
      src: source,
      dst: target,
      type: EdgeType.REFERENCES,
    });

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(edgeBetween(source, target)?.provenance).toBe("agent");
    expect(result.wikilinks_linked).toBe(0);
  });

  it("should follow a supersede when the wikilink still names the retired title", async () => {
    // Given
    const old = await write("Old finding", "what we believed about the retry budget at first");
    const fresh = await write("Newer finding", "what replaced it after the second measurement");
    const source = await write("Plan", "acting on [[old-finding]], which has since moved on");

    await container.resolve(InvalidateTool).invoke({
      session_id: session,
      id: old,
      reason: "measured again",
      superseded_by: fresh,
    });

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(result.wikilinks_linked).toBeGreaterThanOrEqual(1);
    expect(edgeBetween(source, fresh)?.type).toBe(EdgeType.REFERENCES);
  });

  it("should not guess when a retired target has more than one live successor", async () => {
    // Given — the second `supersedes` goes in through the repo: `link` refuses a retired
    // destination, so a store can only reach this state by another route.
    const old = await write("Split finding", "one claim that later became two separate ones");
    const first = await write("First half", "the first of the two claims it was split into");
    const second = await write("Second half", "the second of the two claims it was split into");
    const source = await write("Reader", "this still points at [[split-finding]] as one thing");

    await container.resolve(InvalidateTool).invoke({
      session_id: session,
      id: old,
      reason: "split in two",
      superseded_by: first,
    });
    container
      .resolve(EdgesRepo)
      .insertEdge(second, old, EdgeType.SUPERSEDES, "agent", session, "2026-01-01T00:00:00.000Z");

    // When
    const result = await container.resolve(ConsolidationWorker).tick();

    // Then
    expect(edgeBetween(source, first)).toBeUndefined();
    expect(edgeBetween(source, second)).toBeUndefined();
    expect(result.wikilinks_dangling).toBeGreaterThanOrEqual(1);
  });

  it("should not re-read the bodies when nothing has been written since the last pass", async () => {
    // Given — a dangling link, counted once
    const worker = container.resolve(ConsolidationWorker);
    const lonely = await write("Lonely", "this refers to [[a-node-nobody-ever-wrote]] and stops");

    expect((await worker.tick()).wikilinks_dangling).toBe(1);

    // When — the node carrying it is retired, which adds no revision
    container.resolve(NodesRepo).invalidateNode(lonely, {
      ts: "2026-02-01T00:00:00.000Z",
      session_id: session,
    });

    // Then — the count is the one already known, not one recomputed from live bodies
    expect((await worker.tick()).wikilinks_dangling).toBe(1);

    // And a single new revision is enough to make it look again
    await write("Anything", "a body whose only job is to advance the revision count");

    expect((await worker.tick()).wikilinks_dangling).toBe(0);
  });

  it("should link a wikilink written before its target existed, once it exists", async () => {
    // Given — one worker across both ticks, the way the daemon holds one: a second
    // instance would not hold the lease and would do nothing at all.
    const worker = container.resolve(ConsolidationWorker);
    const source = await write("Forward reference", "this will point at [[written-later]] one day");

    expect((await worker.tick()).wikilinks_linked).toBe(0);

    // When
    const target = await write("Written later", "the node the earlier one was waiting for");

    // Then
    await worker.tick();
    expect(edgeBetween(source, target)?.type).toBe(EdgeType.REFERENCES);
  });
});
