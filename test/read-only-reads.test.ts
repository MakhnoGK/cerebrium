import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { container as globalContainer, type DependencyContainer } from "tsyringe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  READ_SURFACE,
  type FetchNodes,
  type ReadName,
  type UseCase,
} from "@/application/use-cases";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { buildContainer } from "@/container";
import { StaticConfigSource } from "@/infrastructure/config";

// The read pool holds a read-only connection, and from source there is no worker bundle to
// spawn — so every read runs on the writer's handle under `npm run check` and a use case
// that writes passes. `fetch_nodes` did exactly that: it bumps `use_count`, which killed
// `get` against the built daemon while every test stayed green. This builds the reader
// container the pool actually uses and runs the whole surface through it.

const DIR = mkdtempSync(join(tmpdir(), "cerebrium-readonly-"));
const DB_FILE = join(DIR, "store.db");
const OFFLINE = {
  MEMORY_DB_PATH: DB_FILE,
  MEMORY_EMBED_PROVIDER: "local-null",
  MEMORY_CONSOLIDATE: "manual",
};

let reader: DependencyContainer;
let seeded: string;

function argsFor(name: ReadName): unknown {
  switch (name) {
    case "search_memory":
      return { query: "http client retries", limit: 5, mode: "text" };
    case "fetch_nodes":
      return { ids: [seeded] };
    case "lookup_code":
      return { name: "AuthService", limit: 5 };
    case "suggest_candidates":
      return { limit: 5 };
    default:
      return {};
  }
}

beforeAll(async () => {
  openDatabase(DB_FILE).close();

  const writer = globalContainer.createChildContainer();
  buildContainer({ role: "server", source: new StaticConfigSource(OFFLINE), into: writer });

  const { session_id } = await writer.resolve(SessionStartTool).invoke({});
  const written = await writer.resolve(WriteTool).invoke({
    session_id,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: "Retry budget",
    content: "the http client retries with exponential backoff",
  });

  seeded = written.id;
  writer.resolve<BetterSqlite3.Database>(DB_TOKEN).close();

  reader = globalContainer.createChildContainer();
  buildContainer({ role: "reader", source: new StaticConfigSource(OFFLINE), into: reader });
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("Read surface against a read-only handle", () => {
  it.each(Object.keys(READ_SURFACE) as ReadName[])(
    "should answer %s without attempting a write",
    async (name) => {
      // Given
      const useCase = reader.resolve<UseCase<unknown, unknown>>(READ_SURFACE[name]);

      // When / Then
      await expect(useCase.invoke(argsFor(name))).resolves.toBeDefined();
    },
  );

  it("should name the ids it read, so the dispatcher can record the use itself", async () => {
    // Given
    const fetch = reader.resolve<FetchNodes>(READ_SURFACE.fetch_nodes);

    // When
    const result = await fetch.invoke({ ids: [seeded] });

    // Then
    expect(result.used).toEqual([seeded]);
    expect(result.not_found).toEqual([]);
  });

  it("should leave the use count untouched when it cannot write", async () => {
    // Given
    const fetch = reader.resolve<FetchNodes>(READ_SURFACE.fetch_nodes);

    // When
    await fetch.invoke({ ids: [seeded] });
    await fetch.invoke({ ids: [seeded] });

    // Then
    const row = reader
      .resolve<BetterSqlite3.Database>(DB_TOKEN)
      .prepare("SELECT use_count FROM nodes WHERE id = ?")
      .get(seeded) as { use_count: number };

    expect(row.use_count).toBe(0);
  });
});
