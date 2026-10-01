import type Database from "better-sqlite3";
import type { DependencyContainer } from "tsyringe";
import { beforeEach, expect, it } from "vitest";
import { graphIntegrity } from "@cerebrium/contracts/graph";
import { EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  EDGES_REPO_TOKEN,
  GRAPH_REPO_TOKEN,
  NODES_REPO_TOKEN,
  STATS_REPO_TOKEN,
  type EdgesRepo,
  type GraphRepo,
  type NodesRepo,
  type StatsRepo,
} from "@/domain/ports/storage";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { DB_TOKEN } from "@/db/sqlite/base";
import { describeStorage } from "@test/storage-contract/backends";

const T0 = "2026-01-01T00:00:00.000Z";

describeStorage("graph snapshot", (backend) => {
  let scope: DependencyContainer;
  let nodes: NodesRepo;
  let edges: EdgesRepo;
  let graph: GraphRepo;

  const write = async (title: string, kind = MemoryKind.SEMANTIC) =>
    (
      await nodes.createNode({
        memory_kind: kind,
        type: kind === MemoryKind.SEMANTIC ? "fact" : "event_note",
        title,
        content: `# ${title}\n\n${title} opens the body.\n\nMore below.`,
        project: "p",
        session_id: "s",
        ts: T0,
      })
    ).id;

  const link = (src: string, dst: string, type = EdgeType.REFERENCES) =>
    edges.insertEdge(src, dst, type, "agent", "s", T0);

  const retire = (id: string) => nodes.invalidateNode(id, { ts: T0, session_id: "s" });

  async function cite(note: string): Promise<void> {
    if (backend.name === "postgres") {
      await scope.resolve<PgDatabase>(PG_TOKEN).query(
        `INSERT INTO code_refs (src, type, repo, remote_key, path, qualified, symbol_kind,
                                symbol_live, valid_from)
         VALUES (@note, 'documents', 'cerebrium', 'github.com/o/cerebrium', 'src/a.ts',
                 'src/a.ts:Alpha.run', 'method', 1, @ts)`,
        { note, ts: T0 },
      );
      return;
    }

    const db = scope.resolve<Database.Database>(DB_TOKEN);

    db.prepare(
      `INSERT INTO nodes (id, memory_kind, type, title, project, origin, valid_from,
                          created_by_session, created_at)
       VALUES ('sym1', 'mirror', 'method', 'Alpha.run', 'cerebrium', 'code', ?, 's', ?)`,
    ).run(T0, T0);
    db.prepare(
      `INSERT INTO symbols (node_id, repo, path, lang, symbol_kind, name, qualified,
                            start_line, end_line, code_hash, source)
       VALUES ('sym1', 'cerebrium', 'src/a.ts', 'ts', 'method', 'run', 'src/a.ts:Alpha.run',
               1, 2, 'h', 'run() {}')`,
    ).run();
    await link(note, "sym1", EdgeType.DOCUMENTS);
  }

  beforeEach(() => {
    scope = backend.fresh();
    nodes = scope.resolve<NodesRepo>(NODES_REPO_TOKEN);
    edges = scope.resolve<EdgesRepo>(EDGES_REPO_TOKEN);
    graph = scope.resolve<GraphRepo>(GRAPH_REPO_TOKEN);
  });

  it("should draw live nodes, their edges, and the retired nodes a live edge still points at", async () => {
    // Given
    const a = await write("Alpha");
    const b = await write("Beta", MemoryKind.EPISODIC);
    const gone = await write("Gone");
    const buried = await write("Buried");
    await link(a, b);
    await link(a, gone);
    await retire(gone);
    await retire(buried);

    // When
    const snap = await graph.snapshot({ invalidated: false, symbols: false });

    // Then
    expect(snap.nodes.map((n) => n.title).sort()).toEqual(["Alpha", "Beta", "Gone"]);
    expect(snap.nodes.find((n) => n.id === a)).toMatchObject({
      kind: MemoryKind.SEMANTIC,
      type: "fact",
      summary: "Alpha opens the body.",
      project: "p",
      invalidated: false,
    });
    expect(snap.nodes.find((n) => n.id === gone)?.invalidated).toBe(true);
    expect(snap.edges).toEqual(
      expect.arrayContaining([
        { src: a, dst: b, type: EdgeType.REFERENCES, provenance: "agent", weight: 1 },
        { src: a, dst: gone, type: EdgeType.REFERENCES, provenance: "agent", weight: 1 },
      ]),
    );
    expect(snap.edges).toHaveLength(2);
  });

  it("should add every retired node when asked to", async () => {
    // Given
    await write("Alpha");
    await retire(await write("Buried"));

    // When
    const snap = await graph.snapshot({ invalidated: true, symbols: false });

    // Then
    expect(snap.nodes.map((n) => n.title).sort()).toEqual(["Alpha", "Buried"]);
  });

  it("should add the code symbols notes cite only when asked to", async () => {
    // Given
    const a = await write("Alpha");
    await cite(a);

    // When
    const without = await graph.snapshot({ invalidated: false, symbols: false });
    const withSymbols = await graph.snapshot({ invalidated: false, symbols: true });

    // Then
    expect(without.nodes).toHaveLength(1);
    expect(without.edges).toEqual([]);
    const symbol = withSymbols.nodes.find((n) => n.kind === "symbol");
    expect(symbol).toMatchObject({
      type: "method",
      title: "Alpha.run",
      summary: "src/a.ts",
      project: "cerebrium",
      invalidated: false,
    });
    expect(withSymbols.edges).toEqual([
      expect.objectContaining({ src: a, dst: symbol!.id, type: EdgeType.DOCUMENTS }),
    ]);
  });

  it("should measure the same integrity the stats report", async () => {
    // Given
    const hub = await write("Hub");
    const spokes = [await write("One"), await write("Two"), await write("Three")];
    for (const spoke of spokes) await link(hub, spoke);
    const islandA = await write("Island A");
    await link(islandA, await write("Island B"));
    await write("Alone");
    const gone = await write("Gone");
    await link(spokes[0]!, gone);
    await link(spokes[1]!, gone, EdgeType.SUPERSEDES);
    await retire(gone);

    // When
    const integrity = graphIntegrity(await graph.snapshot({ invalidated: true, symbols: false }));
    const health = (await scope.resolve<StatsRepo>(STATS_REPO_TOKEN).techStats(T0)).graph;

    // Then
    expect(integrity.edgeless.size).toBe(1);
    expect(integrity.detached.size).toBe(3);
    expect(integrity.dangling.size).toBe(1);
    expect({
      edgeless: integrity.edgeless.size,
      detached: integrity.detached.size,
      dangling: integrity.dangling.size,
    }).toEqual({
      edgeless: health.edgeless_nodes,
      detached: health.detached_nodes,
      dangling: health.dangling_edges,
    });
  });
});
