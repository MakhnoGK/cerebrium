import { expect, it } from "vitest";
import { compileNamed, PgDatabase, redactUrl } from "@/db/postgres/database";
import { databaseUrl, TEST_PG_URL } from "@test/pg";
import { describePostgres } from "@test/storage-contract/backends";

async function count(db: PgDatabase): Promise<number> {
  return (await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM principals")).rows[0]!.c;
}

function insert(db: PgDatabase, id: string): Promise<unknown> {
  return db.query(
    `INSERT INTO principals (id, kind, label, created_at, last_seen)
     VALUES (@id, 'agent', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    { id },
  );
}

describePostgres("PgDatabase transactions", (fresh) => {
  it("should commit a transaction's writes together", async () => {
    // Given
    const db = fresh();

    // When
    await db.tx(async () => {
      await insert(db, "a");
      await insert(db, "b");
    });

    // Then
    expect(await count(db)).toBe(2);
  });

  it("should roll the whole transaction back when its body throws", async () => {
    // Given
    const db = fresh();

    // When
    const failed = db.tx(async () => {
      await insert(db, "a");
      throw new Error("boom");
    });

    // Then
    await expect(failed).rejects.toThrow("boom");
    expect(await count(db)).toBe(0);
  });

  it("should roll back only the inner savepoint when a nested tx throws and is caught", async () => {
    // Given
    const db = fresh();

    // When
    await db.tx(async () => {
      await insert(db, "outer");
      await db
        .tx(async () => {
          await insert(db, "inner");
          throw new Error("inner failure");
        })
        .catch(() => undefined);
    });

    // Then
    const ids = (await db.query<{ id: string }>("SELECT id FROM principals")).rows.map((r) => r.id);
    expect(ids).toEqual(["outer"]);
  });

  it("should see its own uncommitted writes inside the transaction and hide them outside", async () => {
    // Given
    const db = fresh();
    let inside = -1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    // When
    const writer = db.tx(async () => {
      await insert(db, "a");
      inside = await count(db);
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outside = await db
      .query<{ c: number }>("SELECT COUNT(*) AS c FROM principals")
      .then((r) => r.rows[0]!.c);
    release();
    await writer;

    // Then
    expect(inside).toBe(1);
    expect(outside).toBe(0);
    expect(await count(db)).toBe(1);
  });

  it("should serialize concurrent writers so a read-then-write cannot interleave", async () => {
    // Given
    const db = fresh();
    const bump = () =>
      db.tx(async () => {
        const n = await count(db);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await insert(db, `p${String(n)}`);
      });

    // When
    await Promise.all([bump(), bump(), bump(), bump()]);

    // Then — each writer saw the previous one's row, so every id is distinct
    expect(await count(db)).toBe(4);
  });

  it("should serialize writers across processes through the advisory lock", async () => {
    // Given — a second handle on the same database stands in for another process
    const db = fresh();
    await db.ready();
    const other = new PgDatabase({
      url: databaseUrl(TEST_PG_URL!, new URL(db.identity).pathname.slice(1)),
      poolMax: 2,
      readOnly: false,
    });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    // When
    const first = db.tx(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = other.tx(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([first, second]);
    await other.close();

    // Then
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("should refuse a query from a promise that outlived its transaction", async () => {
    // Given
    const db = fresh();
    let late: Promise<unknown> = Promise.resolve();

    // When
    await db.tx(async () => {
      late = new Promise((resolve) => setTimeout(resolve, 20)).then(() => insert(db, "late"));
    });

    // Then
    await expect(late).rejects.toThrow("already ended");
    expect(await count(db)).toBe(0);
  });

  it("should refuse writes on a read-only handle", async () => {
    // Given
    const db = fresh();
    await db.ready();
    const reader = new PgDatabase({
      url: databaseUrl(TEST_PG_URL!, new URL(db.identity).pathname.slice(1)),
      poolMax: 1,
      readOnly: true,
    });

    // When
    const write = insert(reader, "x");

    // Then
    await expect(write).rejects.toThrow(/read-only/);
    await reader.close();
  });
});

describePostgres("PgDatabase SQL helpers", () => {
  it("should bind a repeated named parameter once and leave search operators alone", () => {
    // Given / When
    const { text, values } = compileNamed(
      "SELECT 1 WHERE a = @x AND b = @y AND c = @x AND tsv @@ q AND d @@@ e",
      { x: 1, y: 2 },
    );

    // Then
    expect(text).toBe("SELECT 1 WHERE a = $1 AND b = $2 AND c = $1 AND tsv @@ q AND d @@@ e");
    expect(values).toEqual([1, 2]);
  });

  it("should throw on a parameter the SQL names but the caller did not pass", () => {
    // Given / When / Then
    expect(() => compileNamed("SELECT @missing", {})).toThrow("@missing");
  });

  it("should strip the password from the identity it publishes", () => {
    // Given / When / Then
    expect(redactUrl("postgres://u:secret@host:5432/db")).toBe("postgres://u@host:5432/db");
  });
});
