import { container, type DependencyContainer } from "tsyringe";
import { describe } from "vitest";
import type { StoreBackend } from "@/domain/ports/storage";
import { registerPostgresRepositories } from "@/db/postgres";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { registerSqliteRepositories } from "@/db/sqlite";
import { DB_TOKEN } from "@/db/sqlite/base";
import { openDatabase } from "@/db/sqlite/database";
import { freshPgDatabase, TEST_PG_URL } from "@test/pg";

export interface Backend {
  name: StoreBackend;
  // A container whose storage tokens resolve against a new, empty store.
  fresh(): DependencyContainer;
}

const sqlite: Backend = {
  name: "sqlite",
  fresh() {
    const scope = container.createChildContainer();

    scope.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
    registerSqliteRepositories(scope);

    return scope;
  },
};

const postgres: Backend = {
  name: "postgres",
  fresh() {
    const scope = container.createChildContainer();

    registerPostgresRepositories(scope, { readOnly: false });
    scope.register(PG_TOKEN, { useValue: freshPgDatabase("local-null") });

    return scope;
  },
};

// Runs the same suite against every backend available: SQLite always, Postgres when a test
// server is configured (it skips visibly otherwise).
export function describeStorage(title: string, suite: (backend: Backend) => void): void {
  describe(`${title} [sqlite]`, () => {
    suite(sqlite);
  });
  describe.skipIf(TEST_PG_URL === null)(`${title} [postgres]`, () => {
    suite(postgres);
  });
}

export function describePostgres(title: string, suite: (fresh: () => PgDatabase) => void): void {
  describe.skipIf(TEST_PG_URL === null)(`${title} [postgres]`, () => {
    suite(() => freshPgDatabase("local-null"));
  });
}
