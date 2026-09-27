import type { DependencyContainer } from "tsyringe";
import { beforeEach, expect, it } from "vitest";
import {
  ConsolidationKind,
  ConsolidationStatus,
  EdgeType,
  MemoryKind,
} from "@cerebrium/contracts/vocab";
import {
  CONSOLIDATION_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  EMBEDDING_QUEUE_REPO_TOKEN,
  NODES_REPO_TOKEN,
  PROCESSES_REPO_TOKEN,
  SEARCH_REPO_TOKEN,
  STORE_TOKEN,
  type ConsolidationRepo,
  type EdgesRepo,
  type EmbeddingQueueRepo,
  type NodesRepo,
  type ProcessesRepo,
  type SearchRepo,
  type Store,
} from "@/domain/ports/storage";
import { parseTextQuery } from "@/core/fts";
import { describeStorage } from "@test/storage-contract/backends";

const T0 = "2026-01-01T00:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function unit(dim: number, hot: number, tilt = 0): number[] {
  const v = Array.from({ length: dim }, () => 0);

  v[hot] = 1;
  if (tilt) v[(hot + 1) % dim] = tilt;

  return v;
}

describeStorage("storage ports", (backend) => {
  let scope: DependencyContainer;
  let nodes: NodesRepo;
  let edges: EdgesRepo;
  let search: SearchRepo;
  let queue: EmbeddingQueueRepo;
  let consolidation: ConsolidationRepo;

  const write = (title: string, content: string, ts = T0, kind = MemoryKind.SEMANTIC) =>
    nodes.createNode({
      memory_kind: kind,
      type: "fact",
      title,
      content,
      project: "p",
      session_id: "s",
      ts,
    });

  const embed = async (id: string, vector: number[]) => {
    const [chunk] = await queue.unembeddedChunks([id], 10);

    await queue.commitNodeEmbeddings(id, [{ chunkId: chunk!.id, vector }], "local-null", "1", T0);
  };

  beforeEach(() => {
    scope = backend.fresh();
    nodes = scope.resolve(NODES_REPO_TOKEN);
    edges = scope.resolve(EDGES_REPO_TOKEN);
    search = scope.resolve(SEARCH_REPO_TOKEN);
    queue = scope.resolve(EMBEDDING_QUEUE_REPO_TOKEN);
    consolidation = scope.resolve(CONSOLIDATION_REPO_TOKEN);
  });

  it("should name its backend and keep the password out of its identity", () => {
    // Given / When
    const store = scope.resolve<Store>(STORE_TOKEN);

    // Then
    expect(store.backend).toBe(backend.name);
    expect(store.identity).not.toContain("cerebrium:cerebrium@");
  });

  it("should append revisions and keep every earlier body readable", async () => {
    // Given
    const node = await write("Token TTL", "fifteen minutes");

    // When
    await nodes.addRevision(node.id, {
      content: "thirty minutes",
      session_id: "s",
      reason: "fix",
      ts: at(1),
    });

    // Then
    expect((await nodes.fullNode(node.id))?.content).toBe("thirty minutes");
    expect(await nodes.revisionContent(node.id, 1)).toBe("fifteen minutes");
    expect((await nodes.listRevisions(node.id)).map((r) => r.rev)).toEqual([1, 2]);
    expect((await nodes.stateAt(node.id, T0))?.content).toBe("fifteen minutes");
  });

  it("should move inbound authored edges onto the successor when a node is superseded", async () => {
    // Given
    const old = await write("Old", "old body");
    const successor = await write("New", "new body");
    const referrer = await write("Referrer", "points at old");
    await edges.insertEdge(referrer.id, old.id, EdgeType.REFERENCES, "agent", "s", T0);

    // When
    await nodes.invalidateNode(old.id, { ts: at(1), superseded_by: successor.id, session_id: "s" });

    // Then
    const out = (await edges.edgesOf(referrer.id)).filter((e) => e.direction === "out");
    expect(out.map((e) => e.id)).toEqual([successor.id]);
    expect(await edges.liveSuccessorsOf(old.id)).toEqual([successor.id]);
    expect(await nodes.referenceState(old.id)).toBe("invalidated");
  });

  it("should restore a superseded node and retire the supersedes edge", async () => {
    // Given
    const old = await write("Old", "old body");
    const successor = await write("New", "new body");
    await nodes.invalidateNode(old.id, { ts: at(1), superseded_by: successor.id, session_id: "s" });

    // When
    const restored = await nodes.restoreNode(old.id, { ts: at(2), session_id: "s" });

    // Then
    expect(restored).toBe(true);
    expect(await nodes.referenceState(old.id)).toBe("live");
    expect(await edges.liveSuccessorsOf(old.id)).toEqual([]);
  });

  it("should reach two hops out over live edges and stop at the depth given", async () => {
    // Given
    const a = await write("A", "a");
    const b = await write("B", "b");
    const c = await write("C", "c");
    const d = await write("D", "d");
    await edges.insertEdge(a.id, b.id, EdgeType.RELATES_TO, "agent", "s", T0);
    await edges.insertEdge(c.id, b.id, EdgeType.RELATES_TO, "agent", "s", T0);
    await edges.insertEdge(c.id, d.id, EdgeType.RELATES_TO, "agent", "s", T0);

    // When
    const two = await edges.subgraphFrom([a.id], {
      depth: 2,
      cap: 50,
      types: [EdgeType.RELATES_TO],
    });

    // Then — d is three hops from a, so the c→d edge is outside the frontier
    const pairs = two.map((e) => `${e.src}>${e.dst}`).sort();
    expect(pairs).toEqual([`${a.id}>${b.id}`, `${c.id}>${b.id}`].sort());
  });

  it("should match words and quoted phrases, and survive operator characters in the query", async () => {
    // Given
    const hit = await write(
      "Retry budget",
      "The upload retries three times with exponential backoff",
    );
    await write("Unrelated", "Nothing about that here");

    // When
    const phrase = await search.search({
      text: parseTextQuery('"exponential backoff"')!,
      history: false,
      cap: 10,
    });
    const hostile = await search.search({
      text: parseTextQuery('backoff AND (NEAR OR "* ^ :')!,
      history: false,
      cap: 10,
    });

    // Then
    expect(phrase.rows.map((r) => r.id)).toEqual([hit.id]);
    expect(hostile.rows.map((r) => r.id)).toContain(hit.id);
    expect(phrase.rows[0]!.text_rank).toBeLessThan(0);
  });

  it("should rank the better text match first with a lower text_rank", async () => {
    // Given
    const strong = await write("Backoff backoff", "backoff backoff backoff retries");
    const weak = await write("Once", "a single backoff among many other unrelated words here");

    // When
    const { rows, total } = await search.search({
      text: parseTextQuery("backoff")!,
      history: false,
      cap: 10,
    });

    // Then
    expect(total).toBe(2);
    expect(rows.map((r) => r.id)).toEqual([strong.id, weak.id]);
    expect(rows[0]!.text_rank).toBeLessThanOrEqual(rows[1]!.text_rank);
  });

  it("should honour as_of on text search, including nodes invalidated since", async () => {
    // Given
    const node = await write("Legacy flag", "the legacy flag", T0);
    await nodes.invalidateNode(node.id, { ts: at(10), session_id: "s" });

    // When
    const now = await search.search({ text: parseTextQuery("legacy")!, history: false, cap: 10 });
    const then = await search.search({
      text: parseTextQuery("legacy")!,
      history: false,
      cap: 10,
      asOf: at(5),
    });

    // Then
    expect(now.rows).toEqual([]);
    expect(then.rows.map((r) => r.id)).toEqual([node.id]);
  });

  it("should return exact nearest neighbours by cosine distance, best chunk per node", async () => {
    // Given
    const near = await write("Near", "near");
    const mid = await write("Mid", "mid");
    const far = await write("Far", "far");
    await embed(near.id, unit(384, 0, 0.1));
    await embed(mid.id, unit(384, 0, 1));
    await embed(far.id, unit(384, 5));

    // When
    const rows = await search.vectorSearch(unit(384, 0), { history: false, cap: 10 });

    // Then
    expect(rows.map((r) => r.id)).toEqual([near.id, mid.id, far.id]);
    expect(rows[0]!.distance).toBeCloseTo(1 - 1 / Math.sqrt(1.01), 5);
    expect(rows[2]!.distance).toBeCloseTo(1, 5);
    expect((await search.vectorsFor([near.id])).get(near.id)?.length).toBe(384);
  });

  it("should dequeue a node once every live chunk has a vector", async () => {
    // Given
    const node = await write("Queued", "one chunk");
    expect((await queue.queueRows(10)).map((r) => r.node_id)).toEqual([node.id]);

    // When
    await embed(node.id, unit(384, 1));

    // Then
    expect(await queue.queueRows(10)).toEqual([]);
    expect(await queue.embeddingStats()).toEqual({ backlog: 0, parked: 0 });
  });

  it("should page pending candidates in one total order with no row skipped or repeated", async () => {
    // Given — equal scores and equal timestamps, so only the id breaks ties
    for (let i = 0; i < 7; i++) {
      await consolidation.insertCandidate({
        kind: ConsolidationKind.LINK,
        member_ids: [`a${String(i)}`, `b${String(i)}`],
        score: i < 4 ? 0.9 : 0.8,
        detected_at: T0,
      });
    }

    // When
    const seen: string[] = [];
    let after: { score: number; detected_at: string; id: string } | undefined;

    for (;;) {
      const page = await consolidation.pendingCandidatePage({
        limit: 3,
        ...(after ? { after } : {}),
      });
      if (!page.length) break;
      seen.push(...page.map((c) => c.id));
      const last = page[page.length - 1]!;
      after = { score: last.score, detected_at: last.detected_at, id: last.id };
    }

    // Then
    const all = (await consolidation.pendingCandidates({ limit: 50 })).map((c) => c.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(7);
  });

  it("should roll back the operation's writes when resolving a candidate fails", async () => {
    // Given
    const a = await write("A", "a");
    const b = await write("B", "b");
    const id = await consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [a.id, b.id],
      canonical_id: a.id,
      score: 0.95,
      detected_at: T0,
    });

    // When
    const failed = consolidation.resolveCandidateAtomically(id!, "tester", at(1), async () => {
      await nodes.invalidateNode(b.id, { ts: at(1), superseded_by: a.id, session_id: "s" });
      throw new Error("apply failed");
    });

    // Then
    await expect(failed).rejects.toThrow("apply failed");
    expect(await nodes.referenceState(b.id)).toBe("live");
    expect((await consolidation.getCandidate(id!))?.status).toBe(ConsolidationStatus.PENDING);
  });

  it("should commit the operation's writes with the resolution when it succeeds", async () => {
    // Given
    const a = await write("A", "a");
    const b = await write("B", "b");
    const id = await consolidation.insertCandidate({
      kind: ConsolidationKind.MERGE,
      member_ids: [a.id, b.id],
      canonical_id: a.id,
      score: 0.95,
      detected_at: T0,
    });

    // When
    const out = await consolidation.resolveCandidateAtomically(id!, "tester", at(1), async () => {
      await nodes.invalidateNode(b.id, { ts: at(1), superseded_by: a.id, session_id: "s" });
      return ConsolidationStatus.APPLIED;
    });

    // Then
    expect(out?.status).toBe(ConsolidationStatus.APPLIED);
    expect(await nodes.referenceState(b.id)).toBe("invalidated");
    expect((await consolidation.getCandidate(id!))?.status).toBe(ConsolidationStatus.APPLIED);
  });

  it("should keep one process row per host and pid", async () => {
    // Given
    const processes = scope.resolve<ProcessesRepo>(PROCESSES_REPO_TOKEN);
    const row = (id: string, host: string, pid: number) => ({
      id,
      role: "daemon",
      host,
      pid,
      started_at: T0,
      node_version: "v26",
      db_path: "x",
      config_file: null,
      config_state: "pinned",
      config_json: "{}",
    });

    // When
    await processes.publish(row("p1", "laptop", 1));
    await processes.publish(row("p2", "container", 1));
    await processes.publish(row("p3", "container", 1));

    // Then
    expect((await processes.list()).map((p) => `${p.host}:${p.id}`).sort()).toEqual([
      "container:p3",
      "laptop:p1",
    ]);
  });
});
