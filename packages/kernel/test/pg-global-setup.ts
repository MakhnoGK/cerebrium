import pg from "pg";
import { PgDatabase } from "@/db/postgres/database";
import { databaseUrl, TEMPLATE_DB, TEST_DB_PREFIX, TEST_PG_URL } from "@test/pg";

async function dropTestDatabases(admin: pg.Pool, includeTemplate: boolean): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE $1 OR ($2 AND datname = $3)",
    [`${TEST_DB_PREFIX.replace(/_/g, "\\_")}%`, includeTemplate, TEMPLATE_DB],
  );

  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}

// Builds the migrated template every test database is copied from. Without a test server
// configured there is nothing to do: the Postgres half of the suite skips.
export async function setup(): Promise<void> {
  if (TEST_PG_URL === null) {
    if (process.env.CEREBRIUM_REQUIRE_PG === "1") {
      throw new Error("CEREBRIUM_REQUIRE_PG=1 but CEREBRIUM_TEST_PG_URL is not set");
    }

    return;
  }

  const admin = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 });

  try {
    await dropTestDatabases(admin, true);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const template = new PgDatabase({
    url: databaseUrl(TEST_PG_URL, TEMPLATE_DB),
    poolMax: 1,
    readOnly: false,
  });

  try {
    await template.ready();
  } finally {
    await template.close();
  }
}

export async function teardown(): Promise<void> {
  if (TEST_PG_URL === null) return;

  const admin = new pg.Pool({ connectionString: TEST_PG_URL, max: 1 });

  try {
    await dropTestDatabases(admin, false);
  } finally {
    await admin.end();
  }
}
