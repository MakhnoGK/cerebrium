import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@/db/database";

const { up: retire } = createRequire(import.meta.url)(
  "../src/db/migrations/028_retire_third_party_symbols.cjs",
) as { up: (db: Database.Database) => void };

// A store indexed before `vendor` was excluded from the walk: the rows are there, and the
// migration has to retire them without leaving a dangling edge behind.
function seed(db: Database.Database): void {
  const node = db.prepare(
    `INSERT INTO nodes (id, memory_kind, type, title, project, valid_from, created_at,
                        created_by_session)
     VALUES (?, 'mirror', 'symbol', ?, NULL, '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', 'seed')`,
  );
  const symbol = db.prepare(
    `INSERT INTO symbols (node_id, repo, path, lang, symbol_kind, name, qualified, signature,
                          start_line, end_line, code_hash, source)
     VALUES (?, 'acme', ?, 'php', 'function', ?, ?, '', 1, 2, 'h', 'src')`,
  );

  for (const [id, path, name] of [
    ["01M0J000000000000000000001", "application/vendor/laravel/framework/Http.php", "handle"],
    ["01M0J000000000000000000002", "application/_ide_helper.php", "stub"],
    ["01M0J000000000000000000003", "application/src/Acme/Domain/User.php", "User"],
  ] as [string, string, string][]) {
    node.run(id, path);
    symbol.run(id, path, name, name);
    db.prepare(
      `INSERT INTO code_files (repo, path, lang, hash, indexed_at)
       VALUES ('acme', ?, 'php', 'h', '2026-01-01T00:00:00.000Z')`,
    ).run(path);
  }

  db.prepare(
    `INSERT INTO edges (src, dst, type, provenance, weight, valid_from, session_id)
     VALUES ('01M0J000000000000000000003', '01M0J000000000000000000001', 'calls', 'system',
             1.0, '2026-01-01T00:00:00.000Z', 'seed')`,
  ).run();
}

function live(db: Database.Database, id: string): boolean {
  return (
    (
      db.prepare("SELECT invalidated_at AS at FROM nodes WHERE id = ?").get(id) as {
        at: string | null;
      }
    ).at === null
  );
}

describe("Retiring third-party symbols already in the store", () => {
  it("should retire the framework code and leave the project's own alone", () => {
    // Given — migrations run on open, so seed a store that predates the exclusion by
    // inserting the rows and running the migration by hand
    const db = openDatabase(":memory:");
    seed(db);

    // When
    retire(db);

    // Then
    expect(live(db, "01M0J000000000000000000001")).toBe(false);
    expect(live(db, "01M0J000000000000000000002")).toBe(false);
    expect(live(db, "01M0J000000000000000000003")).toBe(true);
  });

  it("should not leave an edge pointing at a retired node", () => {
    // Given
    const db = openDatabase(":memory:");
    seed(db);

    // When
    retire(db);

    // Then — `stats` reports these as graph damage, so the migration owns them
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges e
         WHERE e.invalidated_at IS NULL
           AND (EXISTS (SELECT 1 FROM nodes WHERE id = e.src AND invalidated_at IS NOT NULL)
             OR EXISTS (SELECT 1 FROM nodes WHERE id = e.dst AND invalidated_at IS NOT NULL))`,
      )
      .get() as { n: number };

    expect(dangling.n).toBe(0);
  });

  it("should forget that a file it no longer walks was ever indexed", () => {
    // Given
    const db = openDatabase(":memory:");
    seed(db);

    // When
    retire(db);

    // Then — otherwise a later index of a repo that still exists hash-gates the file
    const paths = (db.prepare("SELECT path FROM code_files").all() as { path: string }[]).map(
      (r) => r.path,
    );

    expect(paths).toEqual(["application/src/Acme/Domain/User.php"]);
  });
});
