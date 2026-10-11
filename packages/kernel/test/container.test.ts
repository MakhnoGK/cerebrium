import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container as globalContainer, type InjectionToken } from "tsyringe";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import type { EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { STATS_REPO_TOKEN, type StatsRepo } from "@/domain/ports/storage";
import {
  ConsolidationWorker,
  EmbeddingWorker,
  WORKER_OPTIONS_TOKEN,
  type WorkerOptions,
} from "@/application/workers";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { nowIso } from "@/core/ids";
import { Server } from "@/presentation/mcp/server";
import { buildContainer, KERNEL_TOKENS, type HostRole } from "@/container";
import { ConfigRegistry, StaticConfigSource } from "@/infrastructure/config";
import {
  createFromTemplate,
  databaseUrl,
  dropDatabase,
  TEST_DB_PREFIX,
  TEST_PG_URL,
} from "@test/pg";

const ROLES: HostRole[] = ["server", "daemon", "cli"];

const DB_NAME = `${TEST_DB_PREFIX}${ulid().toLowerCase()}`;

const OFFLINE = {
  MEMORY_PG_URL: databaseUrl(TEST_PG_URL, DB_NAME),
  MEMORY_PG_URL_FILE: "",
  MEMORY_EMBED_PROVIDER: "local-null",
  MEMORY_CONSOLIDATE: "manual",
};

const opened: PgDatabase[] = [];

function build(role: HostRole, env: Record<string, string | undefined> = OFFLINE) {
  return buildContainer({ role, source: new StaticConfigSource(env) });
}

function dbOf(role: HostRole): PgDatabase {
  const db = build(role).resolve<PgDatabase>(PG_TOKEN);

  opened.push(db);

  return db;
}

beforeAll(async () => {
  await createFromTemplate(DB_NAME);
});
afterAll(async () => {
  await Promise.all(opened.map((db) => db.close().catch(() => undefined)));
  await dropDatabase(DB_NAME);
});

describe("buildContainer", () => {
  it("should resolve the configured providers", () => {
    // Given / When
    const c = build("server");

    // Then
    expect(c.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN).name).toBe("local-null");
  });

  it("should batch the drain for the daemon and stay gentle for every other role", () => {
    // Given / When / Then
    expect(
      build("daemon", { ...OFFLINE, MEMORY_EMBED_BATCH: "32" }).resolve<WorkerOptions>(
        WORKER_OPTIONS_TOKEN,
      ),
    ).toEqual({ batchSize: 32 });
    expect(
      build("server", { ...OFFLINE, MEMORY_EMBED_BATCH: "32" }).resolve<WorkerOptions>(
        WORKER_OPTIONS_TOKEN,
      ),
    ).toEqual({});
  });

  it("should cache one database instance per build rather than opening it per resolve", () => {
    // Given / When
    const c = build("server");

    // Then
    expect(c.resolve(PG_TOKEN)).toBe(c.resolve(PG_TOKEN));
  });

  it("should not touch the database until something resolves it", () => {
    // Given / When — no store configured at all.
    const c = build("cli", { ...OFFLINE, MEMORY_PG_URL: "", MEMORY_PG_URL_FILE: "" });

    // Then — building was lazy; only the resolve fails.
    expect(() => c.resolve(PG_TOKEN)).toThrow(/MEMORY_PG_URL/);
  });
});

describe("Host role parity", () => {
  it("should register every kernel token itself, for every role", () => {
    // Given / When / Then — `isRegistered(token, false)` ignores what the parent container
    // already holds, so a token this role failed to register cannot hide behind an
    // inherited one. That inheritance is exactly why a resolve-based check proves nothing.
    for (const role of ROLES) {
      const scope = globalContainer.createChildContainer();
      buildContainer({ role, source: new StaticConfigSource(OFFLINE), into: scope });

      for (const [name, token] of Object.entries(KERNEL_TOKENS)) {
        expect(
          scope.isRegistered(token as InjectionToken<unknown>, false),
          `${role} did not register ${name}`,
        ).toBe(true);
      }
    }
  });

  it("should resolve what each role actually hosts", async () => {
    // Given / When / Then
    expect(build("server").resolve(Server)).toBeDefined();

    const daemon = build("daemon");
    expect(daemon.resolve(EmbeddingWorker)).toBeDefined();
    expect(daemon.resolve(ConsolidationWorker)).toBeDefined();

    const cli = build("cli");
    opened.push(cli.resolve<PgDatabase>(PG_TOKEN));

    expect(
      (await cli.resolve<StatsRepo>(STATS_REPO_TOKEN).techStats(nowIso())).content.nodes_total,
    ).toBe(0);
  });

  it("should refuse a write through the database the cli role resolves", async () => {
    // Given
    const db = dbOf("cli");

    // When / Then
    await expect(db.query("CREATE TABLE nope (x int)")).rejects.toThrow(/read-only/i);
  });
});

describe("Config tiers", () => {
  const HOME = mkdtempSync(join(tmpdir(), "cerebrium-home-"));

  beforeAll(() => {
    writeFileSync(
      join(HOME, "config.json"),
      JSON.stringify({ retrieval: { mmrLambda: 0.42, useWeight: 0.2 } }),
    );
    process.env.CEREBRIUM_HOME = HOME;
  });
  afterAll(() => {
    delete process.env.CEREBRIUM_HOME;
    rmSync(HOME, { recursive: true, force: true });
  });

  // Building with no pinned source is the production path: the file tier only exists there.
  const effective = (role: HostRole) =>
    buildContainer({ role, into: globalContainer.createChildContainer() })
      .resolve(ConfigRegistry)
      .effective();

  it("should resolve every role identically, whatever started first", () => {
    // Given / When
    const [server, daemon, cli] = ROLES.map(effective);

    // Then
    expect(daemon!.values).toEqual(server!.values);
    expect(cli!.values).toEqual(server!.values);
  });

  it("should let config.json beat the declared default and record the tier", () => {
    // Given / When
    const { values, provenance } = effective("server");

    // Then
    expect(values.retrieval!.mmrLambda).toBe(0.42);
    expect(provenance.find((p) => p.path === "retrieval.mmrLambda")?.source).toBe("file");
    expect(provenance.find((p) => p.path === "retrieval.foldSim")?.source).toBe("default");
  });

  it("should report the file it loaded", () => {
    // Given / When
    const report = buildContainer({
      role: "cli",
      into: globalContainer.createChildContainer(),
    }).resolve<ConfigFileReport | null>(CONFIG_FILE_TOKEN);

    // Then
    expect(report).toMatchObject({ path: join(HOME, "config.json"), state: "loaded", keys: 2 });
  });

  it("should report no file at all when a caller pins its own source", () => {
    // Given / When / Then
    expect(build("server").resolve<ConfigFileReport | null>(CONFIG_FILE_TOKEN)).toBeNull();
  });
});
