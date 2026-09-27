import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { container as globalContainer, type InjectionToken } from "tsyringe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_FILE_TOKEN, type ConfigFileReport } from "@/domain/ports/config";
import type { EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import {
  ConsolidationWorker,
  EmbeddingWorker,
  WORKER_OPTIONS_TOKEN,
  type WorkerOptions,
} from "@/application/workers";
import { openDatabase } from "@/db/database";
import { StatsRepo } from "@/db/repositories";
import { DB_TOKEN } from "@/db/repositories/base";
import { nowIso } from "@/core/ids";
import { Server } from "@/presentation/mcp/server";
import { buildContainer, KERNEL_TOKENS, type HostRole } from "@/container";
import { ConfigRegistry, StaticConfigSource } from "@/infrastructure/config";

const ROLES: HostRole[] = ["server", "daemon", "cli"];

const OFFLINE = {
  MEMORY_DB_PATH: ":memory:",
  MEMORY_EMBED_PROVIDER: "local-null",
  MEMORY_CONSOLIDATE: "manual",
};

function build(role: HostRole, env: Record<string, string | undefined> = OFFLINE) {
  return buildContainer({ role, source: new StaticConfigSource(env) });
}

// The `cli` role opens the DB read-only with fileMustExist, so parity across roles has to
// be proven against a real migrated file rather than ":memory:".
const DB_FILE = join(tmpdir(), `cerebrium-container-${String(process.pid)}.db`);
const ON_FILE = { ...OFFLINE, MEMORY_DB_PATH: DB_FILE };

beforeAll(() => {
  openDatabase(DB_FILE).close(); // run the migrations, then release the writer
});
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_FILE}${suffix}`, { force: true });
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
    expect(c.resolve(DB_TOKEN)).toBe(c.resolve(DB_TOKEN));
  });

  it("should not touch the database until something resolves it", () => {
    // Given / When — a path that cannot be opened read-only.
    const c = build("cli", { ...OFFLINE, MEMORY_DB_PATH: "/nonexistent/cerebrium/memory.db" });

    // Then — building was lazy; only the resolve fails.
    expect(() => c.resolve(DB_TOKEN)).toThrow();
  });
});

describe("Host role parity", () => {
  it("should register every kernel token itself, for every role", () => {
    // Given / When / Then — `isRegistered(token, false)` ignores what the parent container
    // already holds, so a token this role failed to register cannot hide behind an
    // inherited one. That inheritance is exactly why a resolve-based check proves nothing.
    for (const role of ROLES) {
      const scope = globalContainer.createChildContainer();
      buildContainer({ role, source: new StaticConfigSource(ON_FILE), into: scope });

      for (const [name, token] of Object.entries(KERNEL_TOKENS)) {
        expect(
          scope.isRegistered(token as InjectionToken<unknown>, false),
          `${role} did not register ${name}`,
        ).toBe(true);
      }
    }
  });

  it("should resolve what each role actually hosts", () => {
    // Given / When / Then
    expect(build("server", ON_FILE).resolve(Server)).toBeDefined();

    const daemon = build("daemon", ON_FILE);
    expect(daemon.resolve(EmbeddingWorker)).toBeDefined();
    expect(daemon.resolve(ConsolidationWorker)).toBeDefined();

    expect(build("cli", ON_FILE).resolve(StatsRepo).techStats(nowIso()).content.nodes_total).toBe(
      0,
    );
  });

  it("should refuse a write through the database the cli role resolves", () => {
    // Given
    const db = build("cli", ON_FILE).resolve<Database.Database>(DB_TOKEN);

    // When / Then
    expect(() => db.exec("CREATE TABLE nope (x)")).toThrow(/readonly/i);
  });
});

describe("Config tiers", () => {
  const HOME = mkdtempSync(join(tmpdir(), "cerebrium-home-"));

  beforeAll(() => {
    writeFileSync(
      join(HOME, "config.json"),
      JSON.stringify({ database: { path: DB_FILE }, retrieval: { mmrLambda: 0.42 } }),
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
