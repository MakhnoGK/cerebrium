import { DEFAULT_RULES, measureParity, parityFailures, type ParityReport } from "@scripts/parity";
import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { NODES_REPO_TOKEN, type NodesRepo } from "@/domain/ports/storage";
import { EmbeddingWorker } from "@/application/workers";
import { registerPostgresRepositories } from "@/db/postgres";
import { PG_TOKEN } from "@/db/postgres/database";
import { importSqlite } from "@/db/postgres/import-sqlite";
import { registerSqliteRepositories } from "@/db/sqlite";
import { DB_TOKEN } from "@/db/sqlite/base";
import { openDatabase } from "@/db/sqlite/database";
import { LocalNullProvider } from "@/embeddings/local-null";
import { freshPgDatabase } from "@test/pg";
import { describePostgres } from "@test/storage-contract/backends";

function report(overrides: Partial<ParityReport> = {}): ParityReport {
  const branch = {
    sqlite: { ndcg: 60, recall: 70, p50: 1, p95: 2 },
    pg: { ndcg: 60, recall: 70, p50: 1, p95: 2 },
    lost: [],
  };

  return {
    queries: 10,
    vector: {
      meanJaccard: 1,
      minJaccard: 1,
      maxDistanceDelta: 0,
      below: [],
      p50: { sqlite: 1, pg: 1 },
    },
    text: branch,
    hybrid: branch,
    gates: { pairs: 2, compared: 2, maxDelta: 0, flips: [] },
    ...overrides,
  };
}

describe("Parity verdict", () => {
  it("should pass identical stores", () => {
    // Given / When / Then
    expect(parityFailures(report())).toEqual([]);
  });

  it("should pass a Postgres store that ranks better", () => {
    // Given
    const better = {
      sqlite: { ndcg: 40, recall: 50, p50: 1, p95: 2 },
      pg: { ndcg: 46, recall: 57, p50: 1, p95: 2 },
      lost: [],
    };

    // When / Then
    expect(parityFailures(report({ text: better, hybrid: better }))).toEqual([]);
  });

  it("should fail a branch that trails SQLite by more than the allowance", () => {
    // Given
    const worse = {
      sqlite: { ndcg: 60, recall: 70, p50: 1, p95: 2 },
      pg: { ndcg: 60 - DEFAULT_RULES.maxWorse - 0.5, recall: 70, p50: 1, p95: 2 },
      lost: [],
    };

    // When
    const failures = parityFailures(report({ hybrid: worse }));

    // Then
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("hybrid ndcg");
  });

  it("should fail when the vector neighbourhoods diverge", () => {
    // Given
    const vector = {
      meanJaccard: 0.99,
      minJaccard: 0.9,
      maxDistanceDelta: 1e-3,
      below: [{ query: "q", jaccard: 0.9 }],
      p50: { sqlite: 1, pg: 1 },
    };

    // When / Then
    expect(parityFailures(report({ vector }))).toHaveLength(2);
  });

  it("should fail when a merge pair crosses a gate", () => {
    // Given
    const gates = {
      pairs: 1,
      compared: 1,
      maxDelta: 0.01,
      flips: [{ a: "a", b: "b", gate: "merge", sqlite: 0.926, pg: 0.924 }],
    };

    // When / Then
    expect(parityFailures(report({ gates }))[0]).toContain("gate");
  });
});

describePostgres("Parity measured on a store and its import", () => {
  it("should find a SQLite store and its Postgres import at parity", async () => {
    // Given — a seeded SQLite store, embedded, then imported
    const provider: EmbeddingProvider = new LocalNullProvider();
    const sqliteDb = openDatabase(":memory:");
    const sqlite = container.createChildContainer();

    sqlite.register(DB_TOKEN, { useValue: sqliteDb });
    registerSqliteRepositories(sqlite);
    sqlite.register(EMBEDDING_PROVIDER_TOKEN, { useValue: provider });

    const nodes = sqlite.resolve<NodesRepo>(NODES_REPO_TOKEN);
    const texts = [
      ["Retry budget", "The upload retries three times with exponential backoff."],
      ["Token lifetime", "Access tokens live fifteen minutes before they must be refreshed."],
      ["Queue parking", "A node that fails five embedding attempts is parked."],
    ];
    const ids: string[] = [];

    for (const [title, content] of texts) {
      const node = await nodes.createNode({
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title: title!,
        content: content!,
        project: "p",
        session_id: "s",
        ts: "2026-01-01T00:00:00.000Z",
      });

      ids.push(node.id);
    }

    await sqlite.resolve(EmbeddingWorker).tick();

    const pgDb = freshPgDatabase(provider.name);
    const pg = container.createChildContainer();

    registerPostgresRepositories(pg, { readOnly: false });
    pg.register(PG_TOKEN, { useValue: pgDb });
    pg.register(EMBEDDING_PROVIDER_TOKEN, { useValue: provider });
    await importSqlite(sqliteDb, pgDb);

    // When
    const measured = await measureParity({
      sqlite,
      pg,
      provider,
      queries: [
        { query: "exponential backoff retries", gold: new Set([ids[0]!]), origins: new Set() },
        { query: "how long do access tokens live", gold: new Set([ids[1]!]), origins: new Set() },
      ],
      kinds: [MemoryKind.SEMANTIC],
      pairs: [[ids[0]!, ids[1]!]],
      gates: { merge: 0.925 },
    });

    // Then
    expect(measured.vector.minJaccard).toBe(1);
    expect(measured.vector.maxDistanceDelta).toBeLessThan(1e-5);
    expect(measured.gates.compared).toBe(1);
    expect(parityFailures(measured)).toEqual([]);
  });
});
