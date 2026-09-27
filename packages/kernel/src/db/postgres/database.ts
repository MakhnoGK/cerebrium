import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { assertMigrated, runMigrations } from "@/db/postgres/migrate";

// int8 (COUNT(*), SUM over integers) arrives as a string by default.
pg.types.setTypeParser(pg.types.builtins.INT8, (raw) => {
  const n = Number(raw);

  if (!Number.isSafeInteger(n)) throw new Error(`int8 ${raw} does not fit a JS number`);

  return n;
});

export const PG_TOKEN = Symbol("PgDatabase");

// Arbitrary, stable keys for the two advisory locks this store takes.
const WRITE_LOCK = 0x63657231;
const MIGRATE_LOCK = 0x63657232;

export type Params = Record<string, unknown>;

export interface PgDatabaseOptions {
  url: string;
  poolMax: number;
  // Reader roles connect with every transaction read-only and never migrate.
  readOnly: boolean;
  // Runs once before the first connection, e.g. to create the database it points at.
  beforeConnect?: () => Promise<void>;
}

interface TxFrame {
  client: pg.PoolClient;
  depth: number;
  open: boolean;
}

// `@name` placeholders become `$n`, one position per distinct name. The lookbehind keeps
// the `@@` / `@@@` search operators intact.
export function compileNamed(
  sql: string,
  params: Params = {},
): { text: string; values: unknown[] } {
  const positions = new Map<string, number>();
  const values: unknown[] = [];

  const text = sql.replace(/(?<![@\w])@([A-Za-z_]\w*)/g, (_m, name: string) => {
    if (!(name in params)) throw new Error(`missing SQL parameter @${name}`);

    let position = positions.get(name);

    if (position === undefined) {
      values.push(params[name]);
      position = values.length;
      positions.set(name, position);
    }

    return `$${String(position)}`;
  });

  return { text, values };
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.password = "";

    return parsed.toString();
  } catch {
    return "postgres://<unparseable url>";
  }
}

// One pool per process. Reads go straight to the pool; every write runs through `tx`, which
// takes the in-process write lane and then the store-wide advisory lock. Inside a
// transaction the client is held in AsyncLocalStorage: repository calls made from the
// callback join it, and a nested `tx` becomes a savepoint.
export class PgDatabase {
  private readonly pool: pg.Pool;
  private readonly als = new AsyncLocalStorage<TxFrame>();
  private lane: Promise<unknown> = Promise.resolve();
  private initialized: Promise<void> | null = null;

  constructor(private readonly options: PgDatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.url,
      max: options.poolMax,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 10_000,
      ...(options.readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
    });
    // An idle client whose connection drops emits here; unhandled, it kills the process.
    this.pool.on("error", (err) => {
      process.stderr.write(`postgres: idle client error: ${err.message}\n`);
    });
  }

  get identity(): string {
    return redactUrl(this.options.url);
  }

  ready(): Promise<void> {
    this.initialized ??= this.initialize();

    return this.initialized;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: Params,
  ): Promise<pg.QueryResult<T>> {
    await this.ready();

    const { text, values } = compileNamed(sql, params);
    const frame = this.als.getStore();

    if (frame === undefined) return this.pool.query<T>(text, values);

    if (!frame.open) {
      throw new Error("query issued on a Postgres transaction that has already ended");
    }

    return frame.client.query<T>(text, values);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready();

    const frame = this.als.getStore();

    if (frame !== undefined) {
      if (!frame.open) {
        throw new Error("transaction opened from a Postgres transaction that has already ended");
      }

      return this.savepoint(frame, fn);
    }

    return this.inLane(async () => {
      const client = await this.pool.connect();
      const own: TxFrame = { client, depth: 0, open: true };

      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);

        const result = await this.als.run(own, fn);

        await client.query("COMMIT");

        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        own.open = false;
        client.release();
      }
    });
  }

  inTransaction(): boolean {
    return this.als.getStore()?.open === true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async savepoint<T>(frame: TxFrame, fn: () => Promise<T>): Promise<T> {
    frame.depth += 1;

    const name = `sp_${String(frame.depth)}`;

    try {
      await frame.client.query(`SAVEPOINT ${name}`);

      const result = await fn();

      await frame.client.query(`RELEASE SAVEPOINT ${name}`);

      return result;
    } catch (err) {
      await frame.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      throw err;
    } finally {
      frame.depth -= 1;
    }
  }

  // FIFO: each writer waits for the one before it, whether that one succeeded or not.
  private inLane<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lane.then(fn, fn);

    this.lane = run.catch(() => undefined);

    return run;
  }

  private async initialize(): Promise<void> {
    await this.options.beforeConnect?.();

    const client = await this.pool.connect();

    try {
      await assertByteOrderCollation(client);

      if (this.options.readOnly) {
        await assertMigrated(client);
      } else {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK]);

        try {
          await runMigrations(client);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK]);
        }
      }
    } finally {
      client.release();
    }
  }
}

// Timestamps and ULIDs are compared as TEXT throughout, which is only correct under a
// byte-order collation. Checked by behaviour rather than by locale name.
async function assertByteOrderCollation(client: pg.PoolClient): Promise<void> {
  const sample = [
    "a",
    "B",
    "-b",
    "_c",
    "1",
    "a.b",
    "ab",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00Z",
  ];
  const { rows } = await client.query<{ sorted: string[] }>(
    "SELECT array_agg(x ORDER BY x) AS sorted FROM unnest($1::text[]) AS x",
    [sample],
  );
  const expected = [...sample].sort();

  if (JSON.stringify(rows[0]?.sorted) !== JSON.stringify(expected)) {
    throw new Error(
      "the Postgres database does not sort text in byte order; create it with --locale=C " +
        "(ISO timestamps and ids are compared as text)",
    );
  }
}
