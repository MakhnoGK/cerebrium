import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import { CONFIG_FILE_TOKEN } from "@/domain/ports/config";
import { PROCESS_PROBE_TOKEN } from "@/domain/ports/process-probe";
import { ProcessRegistryService } from "@/application/services";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { StatsTool } from "@/presentation/mcp/tools/stats";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup } from "@test/helpers";

async function session(): Promise<string> {
  return (await container.resolve(SessionStartTool).invoke({})).session_id;
}
async function writeFact(s: string, title: string): Promise<string> {
  const out = (await container.resolve(WriteTool).invoke({
    session_id: s,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: `a durable fact about ${title} with a body of a few words`,
  })) as { id: string };
  return out.id;
}

describe("StatsRepo.techStats", () => {
  it("should count queue, content, and drain health as nodes are written and embedded", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "one");
    await writeFact(s, "two");

    // When / Then — before draining.
    const before = await env.stats.techStats(env.clock.t);
    expect(before.content.nodes_by_kind.semantic).toBe(2);
    expect(before.content.nodes_total).toBe(2);
    expect(before.queue.backlog).toBe(2);
    expect(before.queue.total).toBe(2);
    expect(before.content.chunks_embedded).toBe(0);
    expect(before.storage.db_bytes).toBeGreaterThan(0);

    // When / Then — after draining.
    await env.worker.tick();
    const after = await env.stats.techStats(env.clock.t);
    expect(after.queue.backlog).toBe(0);
    expect(after.content.chunks_embedded).toBeGreaterThan(0);
    expect(after.content.chunks_unembedded).toBe(0);
    expect(after.content.vectors_authored).toBe(after.content.chunks_embedded);
    expect(after.content.vectors_code).toBe(0);
  });

  it("should report the embedding lease as active while a worker holds it and lapsed later", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "held");
    await env.worker.tick(); // acquires the 'embedding' lease

    // When / Then
    const snap = await env.stats.techStats(env.clock.t);
    expect(snap.drain.lease_owner).toBeTruthy();
    expect(snap.drain.lease_active).toBe(true);

    // Far in the future, the same lease has lapsed.
    const later = new Date(Date.parse(env.clock.t) + 10 * 60_000).toISOString();
    expect((await env.stats.techStats(later)).drain.lease_active).toBe(false);
  });

  it("should count active unembedded chunks when stale embeddings outnumber active chunks", async () => {
    // Given
    const env = setup();
    const s = await session();
    const nodeId = await writeFact(s, "active without an embedding");

    // When
    for (const [seq, id] of ["stale-a", "stale-b"].entries()) {
      await env.sql.run(
        `INSERT INTO chunks (id, node_id, rev, heading_path, seq, text, stale)
         VALUES (@id, @nodeId, 1, NULL, @seq, @text, 1)`,
        { id, nodeId, seq, text: `stale chunk ${seq}` },
      );
      await env.sql.run(
        `INSERT INTO chunk_vectors (space_id, chunk_id, embedding, model_version, ts)
         SELECT id, @id, array_fill(0.1, ARRAY[dim])::vector, '1', @ts
           FROM vector_spaces WHERE active`,
        { id, ts: env.clock.t },
      );
    }

    // Then
    const content = (await env.stats.techStats(env.clock.t)).content;
    expect(content.chunks_embedded).toBeGreaterThan(content.chunks_active);
    expect(content.chunks_unembedded).toBe(1);
  });
});

describe("StatsRepo graph integrity", () => {
  it("should report a clean graph when nothing has been superseded", async () => {
    // Given
    const env = setup();
    const s = await session();
    await writeFact(s, "anchor");
    await writeFact(s, "other");

    // When / Then
    const snap = (await env.stats.techStats(env.clock.t)).graph;
    expect(snap).toEqual({
      dangling_edges: 0,
      repointable_edges: 0,
      detached_nodes: 0,
      edgeless_nodes: 2,
      untyped_links: 0,
      typed_links: 0,
    });
  });

  it("should count an edge left pointing at a superseded node, and call it repointable", async () => {
    // Given — a referrer, a node about to die, and its live successor.
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    const successor = await writeFact(s, "successor");
    await env.edges.insertEdge(referrer, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);
    await env.edges.insertEdge(successor, doomed, EdgeType.SUPERSEDES, "agent", s, env.clock.t);

    // When
    await env.nodes.invalidateNode(doomed, { ts: env.clock.t, session_id: s });

    // Then — the supersedes edge itself is not counted; the stranded reference is.
    const snap = (await env.stats.techStats(env.clock.t)).graph;
    expect(snap.dangling_edges).toBe(1);
    expect(snap.repointable_edges).toBe(1);
  });

  it("should retire system similarities when a node is invalidated", async () => {
    // Given
    const env = setup();
    const s = await session();
    const referrer = await writeFact(s, "referrer");
    const doomed = await writeFact(s, "doomed");
    const successor = await writeFact(s, "successor");
    await env.edges.insertEdge(referrer, doomed, EdgeType.SIMILAR_TO, "system", s, env.clock.t);
    await env.edges.insertEdge(successor, doomed, EdgeType.SUPERSEDES, "agent", s, env.clock.t);

    // When
    await env.nodes.invalidateNode(doomed, { ts: env.clock.t, session_id: s });

    // Then
    const snap = (await env.stats.techStats(env.clock.t)).graph;
    expect(snap.dangling_edges).toBe(0);
    expect(snap.repointable_edges).toBe(0);
  });

  it("should report a node as detached when superseding its only anchor strands it", async () => {
    // Given — `island` hangs off `doomed` alone, while a hub keeps the rest connected.
    const env = setup();
    const s = await session();
    const hub = await writeFact(s, "hub");
    const spoke = await writeFact(s, "spoke");
    const doomed = await writeFact(s, "doomed");
    const island = await writeFact(s, "island");
    await env.edges.insertEdge(hub, spoke, EdgeType.REFERENCES, "agent", s, env.clock.t);
    await env.edges.insertEdge(hub, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);
    await env.edges.insertEdge(island, doomed, EdgeType.REFERENCES, "agent", s, env.clock.t);

    // When
    await env.nodes.invalidateNode(doomed, { ts: env.clock.t, session_id: s });

    // Then
    expect((await env.stats.techStats(env.clock.t)).graph.detached_nodes).toBe(1);
  });
});

describe("StatsTool", () => {
  it("should return the snapshot and augment drain with provider info when called", async () => {
    // Given
    setup();
    const s = await session();
    await writeFact(s, "x");

    // When
    const out = (await container.resolve(StatsTool).invoke({ session_id: s })) as Record<
      string,
      any
    >;

    // Then
    expect(out.queue.backlog).toBe(1);
    expect(out.drain.provider).toBe("local-null@1");
    expect(out.drain).toHaveProperty("daemon_alive");
    // NOTE: event-log assertions are deferred until the DI logger lands (logging is a TODO).
  });

  it("should work without a session_id when peeked read-only", async () => {
    // Given
    setup();

    // When
    const out = (await container.resolve(StatsTool).invoke({})) as Record<string, any>;

    // Then
    expect(out.queue.total).toBe(0);
  });
});

describe("StatsTool observability channels", () => {
  it("should list the registered processes and any unusable configuration", async () => {
    // Given
    setup();
    container.register(PROCESS_PROBE_TOKEN, {
      useValue: { self: () => 700, alive: () => true, host: () => "laptop" },
    });
    container.register(CONFIG_FILE_TOKEN, { useFactory: () => null });
    await container.resolve(ProcessRegistryService).publish("server");

    // When
    const out = (await container.resolve(StatsTool).invoke({})) as {
      processes: { role: string; pid: number; alive: boolean }[];
      config: { ignored: string[] };
    };

    // Then
    expect(out.processes).toEqual([
      expect.objectContaining({ role: "server", pid: 700, alive: true }),
    ]);
    expect(out.config.ignored).toEqual([]);
  });
});
