import { rmSync } from "node:fs";
import { container } from "tsyringe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALL_SURFACE,
  callDeadlineMs,
  INDEX_CODE,
  SEARCH_MEMORY,
  type CallName,
  type IndexCode,
  type SearchMemory,
} from "@/application/use-cases";
import { closeRpcConnections } from "@/runtime/rpc-client";
import { RPC_DEADLINE_MS, RpcWork } from "@/core/rpc";
import { RpcServer } from "@/presentation/rpc";
import { buildContainer } from "@/container";
import { StaticConfigSource } from "@/infrastructure/config";

const SOCKET = `/tmp/cb-deadline-${String(process.pid)}.sock`;
const SESSION = "01JJJJJJJJJJJJJJJJJJJJJJJJ";

let server: RpcServer | null = null;

function remote() {
  return buildContainer({
    role: "server",
    kernel: "remote",
    into: container.createChildContainer(),
    source: new StaticConfigSource({
      MEMORY_DAEMON_SOCKET: SOCKET,
      MEMORY_DB_PATH: "/nonexistent/x.db",
    }),
  });
}

// A daemon that takes the request and never answers — what a busy one looks like from here.
async function silent(): Promise<void> {
  const never = () => new Promise<never>(() => undefined);

  server = new RpcServer({ search_memory: never, index_code: never });
  await server.listen(SOCKET);
}

afterEach(async () => {
  vi.useRealTimers();
  closeRpcConnections();
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("The deadline a call is measured against", () => {
  it("should be positive for every call on the surface", () => {
    for (const name of Object.keys(CALL_SURFACE) as CallName[]) {
      expect(callDeadlineMs(name)).toBeGreaterThan(0);
    }
  });

  it("should be the interactive budget for a read, and its own for each slow write", () => {
    // Then
    expect(callDeadlineMs("search_memory")).toBe(RPC_DEADLINE_MS[RpcWork.INTERACTIVE]);
    expect(callDeadlineMs("write_memory")).toBe(RPC_DEADLINE_MS[RpcWork.GENERATIVE]);
    expect(callDeadlineMs("index_code")).toBe(RPC_DEADLINE_MS[RpcWork.INDEXING]);
    expect(callDeadlineMs("index_code")).toBeGreaterThan(callDeadlineMs("write_memory"));
    expect(callDeadlineMs("write_memory")).toBeGreaterThan(callDeadlineMs("search_memory"));
  });
});

describe("A call the daemon has not answered", () => {
  it("should still be waiting for index_code long after an interactive call would have given up", async () => {
    // Given
    await silent();
    vi.useFakeTimers();

    const failures: string[] = [];
    const call = remote()
      .resolve<IndexCode>(INDEX_CODE)
      .invoke({ session_id: SESSION, repo: "cerebrium" })
      .catch((err: unknown) => failures.push(String(err)));

    // When
    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS[RpcWork.INTERACTIVE] + 1_000);

    // Then
    expect(failures).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS[RpcWork.INDEXING]);
    await call;

    expect(failures[0]).toContain(`${String(RPC_DEADLINE_MS[RpcWork.INDEXING])}ms`);
    expect(failures[0]).toContain("did not answer index_code");
  });

  it("should report a read as unreachable at the interactive deadline", async () => {
    // Given
    await silent();
    vi.useFakeTimers();

    const failures: string[] = [];
    const call = remote()
      .resolve<SearchMemory>(SEARCH_MEMORY)
      .invoke({ session_id: SESSION, query: "anything", limit: 5 })
      .catch((err: unknown) => failures.push(String(err)));

    // When
    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS[RpcWork.INTERACTIVE] + 1);
    await call;

    // Then
    expect(failures[0]).toContain(`${String(RPC_DEADLINE_MS[RpcWork.INTERACTIVE])}ms`);
    expect(failures[0]).toContain("This is a read: retry it");
  });
});
