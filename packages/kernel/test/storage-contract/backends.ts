import { container, type DependencyContainer } from "tsyringe";
import { describe } from "vitest";
import type { StoreBackend } from "@/domain/ports/storage";
import { registerPostgresRepositories } from "@/db/postgres";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { freshPgDatabase } from "@test/pg";

export interface Backend {
  name: StoreBackend;
  // A container whose storage tokens resolve against a new, empty store.
  fresh(): DependencyContainer;
}

const postgres: Backend = {
  name: "postgres",
  fresh() {
    const scope = container.createChildContainer();

    registerPostgresRepositories(scope, { readOnly: false });
    scope.register(PG_TOKEN, { useValue: freshPgDatabase("local-null") });

    return scope;
  },
};

export function describeStorage(title: string, suite: (backend: Backend) => void): void {
  describe(title, () => {
    suite(postgres);
  });
}

export function describePostgres(title: string, suite: (fresh: () => PgDatabase) => void): void {
  describe(title, () => {
    suite(() => freshPgDatabase("local-null"));
  });
}
