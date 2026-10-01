import { container } from "tsyringe";
import { expect, it } from "vitest";
import { EdgeType, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  CODE_REPO_TOKEN,
  EDGES_REPO_TOKEN,
  NODES_REPO_TOKEN,
  type CodeRepo,
  type EdgesRepo,
  type NodesRepo,
} from "@/domain/ports/storage";
import { importSqlite, inScope, remapCodeRefs, verifyImport } from "@/db/postgres/import-sqlite";
import { registerSqliteRepositories } from "@/db/sqlite";
import { DB_TOKEN } from "@/db/sqlite/base";
import { openDatabase } from "@/db/sqlite/database";
import { describePostgres } from "@test/storage-contract/backends";

async function seeded() {
  const db = openDatabase(":memory:");
  const scope = container.createChildContainer();

  scope.register(DB_TOKEN, { useValue: db });
  registerSqliteRepositories(scope);

  const nodes = scope.resolve<NodesRepo>(NODES_REPO_TOKEN);

  for (const title of ["One", "Two"]) {
    await nodes.createNode({
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: `${title} body`,
      project: "p",
      session_id: "s",
      ts: "2026-01-01T00:00:00.000Z",
    });
  }

  db.prepare(
    `INSERT INTO sessions (id, project, started_at, last_seen, client, client_version, principal_id)
     VALUES ('s', 'p', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'test', '1', 'test')`,
  ).run();

  return db;
}

const TS = "2026-01-01T00:00:00.000Z";
const MAP = { widgets: "github.com/acme/widgets" };

// A note that documents one symbol of the SQLite code mirror.
async function withCodeRef() {
  const db = await seeded();
  const scope = container.createChildContainer();

  scope.register(DB_TOKEN, { useValue: db });
  registerSqliteRepositories(scope);

  await scope.resolve<CodeRepo>(CODE_REPO_TOKEN).applyFileIndex({
    repo: "widgets",
    path: "src/a.ts",
    lang: "typescript",
    fileHash: "h1",
    symbols: [
      {
        external_id: "e1",
        symbol_kind: "function",
        name: "foo",
        qualified: "src/a.ts:foo",
        signature: "function foo()",
        summary: "function foo()",
        start_line: 1,
        end_line: 1,
        code_hash: "c1",
        source: "function foo() {}",
      },
    ],
    defines: [],
    session_id: "s",
    ts: TS,
  });

  const symbol = (db.prepare("SELECT node_id FROM symbols").get() as { node_id: string }).node_id;
  const note = (db.prepare("SELECT id FROM nodes WHERE title = 'One'").get() as { id: string }).id;

  await scope
    .resolve<EdgesRepo>(EDGES_REPO_TOKEN)
    .insertEdge(note, symbol, EdgeType.DOCUMENTS, "agent", "s", TS);

  return db;
}

// Notes in an in-scope project, a prefixed one, an out-of-scope one and none, linked in a
// chain so every edge but one crosses into the out-of-scope note.
async function acrossProjects() {
  const db = openDatabase(":memory:");
  const scope = container.createChildContainer();

  scope.register(DB_TOKEN, { useValue: db });
  registerSqliteRepositories(scope);

  const nodes = scope.resolve<NodesRepo>(NODES_REPO_TOKEN);
  const ids: Record<string, string> = {};

  for (const [title, project] of [
    ["Kept", "keep"],
    ["Prefixed", "keep-sub"],
    ["Left", "other"],
    ["Global", null],
  ] as const) {
    const { id } = await nodes.createNode({
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: `${title} body`,
      project,
      session_id: "s",
      ts: TS,
    });

    ids[title] = id;
  }

  const edges = scope.resolve<EdgesRepo>(EDGES_REPO_TOKEN);

  await edges.insertEdge(ids.Kept!, ids.Prefixed!, EdgeType.RELATES_TO, "agent", "s", TS);
  await edges.insertEdge(ids.Kept!, ids.Left!, EdgeType.RELATES_TO, "agent", "s", TS);
  db.prepare(
    `INSERT INTO events (id, session_id, action, node_id, detail, ts)
     VALUES ('e1', 's', 'write', ?, NULL, ?), ('e2', 's', 'write', ?, NULL, ?)`,
  ).run(ids.Kept, TS, ids.Left, TS);

  return { db, ids };
}

const SCOPE = { projects: ["keep*"], global: false };

it("should match exact names, prefix patterns and project-less nodes only when global", () => {
  // Given
  const scope = { projects: ["cerebrium", "toonspace*"], global: true };

  // When
  const matched = ["cerebrium", "toonspace", "toonspace-builder", "cerebrium-x", "obrio", null].map(
    (project) => inScope(scope, project),
  );

  // Then
  expect(matched).toEqual([true, true, true, false, false, true]);
  expect(inScope({ ...scope, global: false }, null)).toBe(false);
});

describePostgres("SQLite import", (fresh) => {
  it("should carry only in-scope nodes and the rows that touch nothing else, and verify them", async () => {
    // Given
    const { db: source, ids } = await acrossProjects();
    const target = fresh();

    // When
    const report = await importSqlite(source, target, { scope: SCOPE });
    const verified = await verifyImport(source, target, { scope: SCOPE });
    const nodes = await target.query("SELECT title FROM nodes ORDER BY title");
    const edges = await target.query("SELECT src, dst FROM edges");
    const events = await target.query("SELECT id FROM events");

    // Then
    expect(verified.ok).toBe(true);
    expect(report.dropped.out_of_scope_nodes).toBe(2);
    expect(nodes.rows).toEqual([{ title: "Kept" }, { title: "Prefixed" }]);
    expect(edges.rows).toEqual([{ src: ids.Kept, dst: ids.Prefixed }]);
    expect(events.rows).toEqual([{ id: "e1" }]);
  });

  it("should carry project-less nodes when the scope is global", async () => {
    // Given
    const { db: source } = await acrossProjects();
    const target = fresh();
    const scope = { ...SCOPE, global: true };

    // When
    await importSqlite(source, target, { scope });
    const verified = await verifyImport(source, target, { scope });
    const nodes = await target.query("SELECT title FROM nodes ORDER BY title");

    // Then
    expect(verified.ok).toBe(true);
    expect(nodes.rows).toEqual([{ title: "Global" }, { title: "Kept" }, { title: "Prefixed" }]);
  });

  it("should carry a note's code link under the repo's remote_key and verify it", async () => {
    // Given
    const source = await withCodeRef();
    const target = fresh();

    // When
    await importSqlite(source, target, { repoMap: MAP });
    const verified = await verifyImport(source, target, { repoMap: MAP });
    const refs = await target.query("SELECT repo, remote_key, path, qualified FROM code_refs");

    // Then
    expect(verified.ok).toBe(true);
    expect(verified.tables.code_refs).toMatchObject({ source: 1, target: 1, hash_match: true });
    expect(refs.rows).toEqual([
      { repo: "widgets", remote_key: MAP.widgets, path: "src/a.ts", qualified: "src/a.ts:foo" },
    ]);
  });

  it("should name remote_keys on refs already imported, and keep them through a re-import", async () => {
    // Given
    const source = await withCodeRef();
    const target = fresh();
    await importSqlite(source, target);

    // When
    const remapped = await remapCodeRefs(target, { ...MAP, elsewhere: "github.com/acme/other" });
    await importSqlite(source, target);
    const refs = await target.query("SELECT remote_key FROM code_refs");

    // Then
    expect(remapped).toEqual({ elsewhere: 0, widgets: 1 });
    expect(refs.rows).toEqual([{ remote_key: MAP.widgets }]);
  });

  it("should fail verification when a code link is missing from the target", async () => {
    // Given
    const source = await withCodeRef();
    const target = fresh();
    await importSqlite(source, target);

    // When
    await target.query("UPDATE code_refs SET path = 'src/moved.ts'");
    const verified = await verifyImport(source, target);

    // Then
    expect(verified.ok).toBe(false);
    expect(verified.tables.code_refs).toMatchObject({ source: 1, target: 0, target_only: 1 });
  });

  it("should converge on a re-run and verify every table", async () => {
    // Given
    const source = await seeded();
    const target = fresh();

    // When
    await importSqlite(source, target);
    await importSqlite(source, target);
    const verified = await verifyImport(source, target);

    // Then
    expect(verified.ok).toBe(true);
    expect(verified.tables.nodes).toMatchObject({ source: 2, target: 2, hash_match: true });
  });

  it("should still verify when the target holds rows of its own", async () => {
    // Given
    const source = await seeded();
    const target = fresh();
    await importSqlite(source, target);

    // When
    await target.query(
      `INSERT INTO sessions (id, project, started_at, last_seen, client, client_version, principal_id)
       VALUES ('daemon-own', NULL, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'cerebrium-daemon', '1', 'cerebrium-daemon')`,
    );
    const verified = await verifyImport(source, target);

    // Then
    expect(verified.ok).toBe(true);
    expect(verified.tables.sessions).toMatchObject({ source: 1, target: 1, target_only: 1 });
  });

  it("should fail when an imported row no longer matches its source", async () => {
    // Given
    const source = await seeded();
    const target = fresh();
    await importSqlite(source, target);

    // When
    await target.query("UPDATE node_text SET body = 'tampered' WHERE title = 'One'");
    const verified = await verifyImport(source, target);

    // Then
    expect(verified.ok).toBe(false);
    expect(verified.tables.node_text?.hash_match).toBe(false);
  });
});
