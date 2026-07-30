import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "@/domain/ports/embedding-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import type { RerankProvider } from "@/domain/ports/rerank-provider";
import { RERANK_PROVIDER_TOKEN } from "@/domain/ports/rerank-provider";
import { WORKER_OPTIONS_TOKEN, type WorkerOptions } from "@/application/workers";
import { DB_TOKEN } from "@/db/repositories/base";
import { buildContainer, KERNEL_TOKENS, type HostRole } from "@/container";
import { StaticConfigSource } from "@/infrastructure/config";

const ROLES: HostRole[] = ["server", "daemon", "cli"];

const OFFLINE = {
  MEMORY_DB_PATH: ":memory:",
  MEMORY_EMBED_PROVIDER: "local-null",
  MEMORY_RERANK: "off",
  MEMORY_CONSOLIDATE: "manual",
};

function build(role: HostRole, env: Record<string, string | undefined> = OFFLINE) {
  return buildContainer({ role, source: new StaticConfigSource(env) });
}

describe("buildContainer", () => {
  it("should register every kernel token for every role", () => {
    // Given / When / Then
    for (const role of ROLES) {
      const c = build(role);

      for (const token of KERNEL_TOKENS) {
        expect(c.isRegistered(token), `${role} is missing a kernel token`).toBe(true);
      }
    }
  });

  it("should resolve the configured providers", () => {
    // Given / When
    const c = build("server");

    // Then
    expect(c.resolve<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN).name).toBe("local-null");
    expect(c.resolve<RerankProvider>(RERANK_PROVIDER_TOKEN).enabled).toBe(false);
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
