import pg from "pg";
import { ulid } from "ulid";
import { PgDatabase } from "@/db/postgres/database";

// The Postgres half of the suite. `CEREBRIUM_TEST_PG_URL` names a server the suite may
// create and drop databases on (never a real store); `CEREBRIUM_TEST_BACKEND=postgres`
// reruns the ordinary suites against it.
export const TEST_PG_URL = process.env.CEREBRIUM_TEST_PG_URL ?? null;
export const TEST_BACKEND =
  process.env.CEREBRIUM_TEST_BACKEND === "postgres" ? "postgres" : "sqlite";
export const TEMPLATE_DB = "cerebrium_tpl";
export const TEST_DB_PREFIX = "t_";

const CREATE_LOCK = 0x74657374;

export function databaseUrl(base: string, name: string): string {
  const url = new URL(base);

  url.pathname = `/${name}`;

  return url.toString();
}

let admin: pg.Pool | null = null;

function adminPool(): pg.Pool {
  if (TEST_PG_URL === null) throw new Error("CEREBRIUM_TEST_PG_URL is not set");

  admin ??= new pg.Pool({ connectionString: TEST_PG_URL, max: 2, allowExitOnIdle: true });

  return admin;
}

// Two CREATE DATABASE … TEMPLATE from the same template at once fail on "source database
// is being accessed by other users", so creation is serialized across test workers.
export async function createFromTemplate(name: string): Promise<void> {
  const client = await adminPool().connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [CREATE_LOCK]);
    await client.query(`CREATE DATABASE "${name}" TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [CREATE_LOCK]).catch(() => undefined);
    client.release();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  await adminPool().query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

interface Current {
  db: PgDatabase;
  name: string;
}

// A test may hold a few stores at once (two clients, a writer and a reader); older ones
// are closed and dropped, so a worker never holds more than this.
const KEEP = 4;

const live: Current[] = [];
let retiring: Promise<void> = Promise.resolve();

// A database of its own for each `setup()`, created from the migrated template on first
// use. Its active vector space takes the test's provider as its model, since the store
// refuses vectors from any other.
export function freshPgDatabase(spaceModel: string): PgDatabase {
  while (live.length >= KEEP) {
    const oldest = live.shift()!;

    retiring = retiring
      .then(() => oldest.db.close())
      .then(() => dropDatabase(oldest.name))
      .catch(() => undefined);
  }

  const created = createPgDatabase(spaceModel);

  live.push(created);

  return created.db;
}

const standing: Current[] = [];

// The root container's store. Anything it caches (the use recorder, for one) keeps using
// it for the whole file, so it is never rotated out.
export function standingPgDatabase(spaceModel: string): PgDatabase {
  const created = createPgDatabase(spaceModel);

  standing.push(created);

  return created.db;
}

// Every database this test file created. Without it each file's databases stay until the
// run ends, and a few hundred template copies fill a tmpfs server.
export async function releasePgDatabases(): Promise<void> {
  const all = [...live.splice(0), ...standing.splice(0)];

  await retiring;
  await Promise.all(all.map((c) => c.db.close().catch(() => undefined)));

  for (const c of all) await dropDatabase(c.name).catch(() => undefined);
}

function createPgDatabase(spaceModel: string): Current {
  const name = `${TEST_DB_PREFIX}${ulid().toLowerCase()}`;
  const settled = retiring;
  const url = databaseUrl(TEST_PG_URL ?? "", name);
  const db = new PgDatabase({
    url,
    poolMax: 4,
    readOnly: false,
    beforeConnect: async () => {
      await settled;
      await createFromTemplate(name);

      const client = new pg.Client({ connectionString: url });

      await client.connect();

      try {
        await client.query("UPDATE vector_spaces SET model = $1 WHERE active", [spaceModel]);
      } finally {
        await client.end();
      }
    },
  });

  return { db, name };
}
