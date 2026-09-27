import { container } from "tsyringe";
import { expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { importSqlite, verifyImport } from "@/db/postgres/import-sqlite";
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

describePostgres("SQLite import", (fresh) => {
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
