import "reflect-metadata";
import { container } from "tsyringe";
import { afterAll } from "vitest";
import { PG_TOKEN } from "@/db/postgres/database";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";
import { releasePgDatabases, standingPgDatabase, TEST_BACKEND, TEST_PG_URL } from "@test/pg";

// The suite wires itself through the same buildContainer the three hosts use, so a token
// cannot be registered in production and missing here (or the reverse).
//
// The pins sit AHEAD of the environment: no model download, no API key, and above all
// never the real database — an ambient MEMORY_DB_PATH must not point the suite at
// ~/.cerebrium/memory.db. Everything else still reads the environment live, which the
// tests that set MEMORY_* inside a test body rely on.
// The store is pinned too, so an ambient MEMORY_PG_URL can never reach a real database:
// on the Postgres run each `setup()` swaps in a database of its own (see @test/pg).
buildContainer({
  role: "server",
  source: new LayeredConfigSource(
    new StaticConfigSource({
      MEMORY_DB_PATH: ":memory:",
      MEMORY_EMBED_PROVIDER: "local-null",
      MEMORY_CONSOLIDATE: "manual",
      MEMORY_STORE_BACKEND: TEST_BACKEND,
      MEMORY_PG_URL: TEST_BACKEND === "postgres" ? (TEST_PG_URL ?? "") : "",
      MEMORY_PG_URL_FILE: "",
      MEMORY_RPC_LISTEN: "",
      MEMORY_KERNEL_URL: "",
      MEMORY_KERNEL_TOKEN_FILE: "",
    }),
    new EnvConfigSource(),
  ),
});

if (TEST_BACKEND === "postgres") {
  container.register(PG_TOKEN, { useValue: standingPgDatabase("local-null") });
}

if (TEST_PG_URL !== null) {
  afterAll(releasePgDatabases);
}
