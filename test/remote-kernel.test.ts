import { rmSync } from "node:fs";
import { container } from "tsyringe";
import type { InjectionToken } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALL_SURFACE,
  SEARCH_MEMORY,
  WRITE_MEMORY,
  type SearchMemory,
  type WriteMemory,
} from "@/application/use-cases";
import { RpcUnavailableError } from "@/runtime/rpc-client";
import { RpcServer, surfaceMethods } from "@/presentation/rpc";
import { buildContainer, KERNEL_TOKENS } from "@/container";
import { StaticConfigSource } from "@/infrastructure/config";

const SOCKET = `/tmp/cb-remote-${String(process.pid)}.sock`;

let server: RpcServer | null = null;

function remote() {
  // A child container so the remote registrations do not leak into the rest of the suite.
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

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("Remote kernel", () => {
  it("should resolve a use case that talks to the socket instead of a database", async () => {
    // Given
    const seen: { name: string; args: unknown }[] = [];
    server = new RpcServer(
      surfaceMethods((name, args) => {
        seen.push({ name, args });

        return Promise.resolve({
          results: [{ id: "01JJJJJJJJJJJJJJJJJJJJJJJJ" }],
          total_matches: 1,
        });
      }),
    );
    await server.listen(SOCKET);

    // When
    const search = remote().resolve<SearchMemory>(SEARCH_MEMORY);
    const out = await search.invoke({ query: "anything", limit: 5 });

    // Then
    expect(seen).toEqual([{ name: "search_memory", args: { query: "anything", limit: 5 } }]);
    expect(out.total_matches).toBe(1);
  });

  it("should register no data-plane kernel token of its own, database included", () => {
    // Given / When
    const scope = remote();

    // Then — `isRegistered(token, false)` ignores what the parent holds, which is the only
    // way to assert this: a child container inherits, so a resolve-based check would pass
    // for the wrong reason. This is the design's guard that a remote host cannot reach the
    // file even by accident.
    // Config is not the kernel: remote still resolves it, because that is where the socket
    // path comes from. Everything that touches data must be absent.
    const dataPlane = Object.entries(KERNEL_TOKENS).filter(
      ([name]) => name !== "configSource" && name !== "configFile",
    );

    expect(dataPlane.length).toBeGreaterThan(0);

    for (const [name, token] of dataPlane) {
      expect(
        scope.isRegistered(token as InjectionToken<unknown>, false),
        `remote should not register ${name}`,
      ).toBe(false);
    }
  });

  it("should register every call on the surface itself", () => {
    // Given / When
    const scope = remote();

    // Then — the mirror of the local parity test: a token remote failed to provide would
    // otherwise fall through to a local implementation and quietly touch the database.
    for (const [name, entry] of Object.entries(CALL_SURFACE)) {
      expect(
        scope.isRegistered(entry.token as InjectionToken<unknown>, false),
        `remote did not register ${name}`,
      ).toBe(true);
    }
  });

  it("should carry a write across the socket rather than performing it locally", async () => {
    // Given
    const seen: string[] = [];
    server = new RpcServer(
      surfaceMethods((name) => {
        seen.push(name);

        return Promise.resolve({ envelope: { id: "01JJJJJJJJJJJJJJJJJJJJJJJJ" } });
      }),
    );
    await server.listen(SOCKET);

    // When
    const write = remote().resolve<WriteMemory>(WRITE_MEMORY);
    await write.invoke({
      session_id: "01JJJJJJJJJJJJJJJJJJJJJJJJ",
      parent_node_id: null,
      memory_kind: "semantic",
      type: "fact",
      title: "t",
      content: "c",
      project: null,
    } as never);

    // Then
    expect(seen).toEqual(["write_memory"]);
  });

  it("should surface an absent daemon as unavailable, so a caller can fall back", async () => {
    // Given — nothing listening.
    const search = remote().resolve<SearchMemory>(SEARCH_MEMORY);

    // When / Then
    await expect(search.invoke({ query: "x", limit: 1 })).rejects.toBeInstanceOf(
      RpcUnavailableError,
    );
  });

  it("should pass an error the daemon reported back to the caller", async () => {
    // Given
    server = new RpcServer(surfaceMethods(() => Promise.reject(new Error("Unknown session_id"))));
    await server.listen(SOCKET);

    // When / Then — a daemon-side rejection is not an availability problem, and a caller
    // must be able to tell them apart.
    const search = remote().resolve<SearchMemory>(SEARCH_MEMORY);
    const failure = search.invoke({ query: "x", limit: 1 });

    await expect(failure).rejects.toThrow(/Unknown session_id/);
    await expect(failure).rejects.not.toBeInstanceOf(RpcUnavailableError);
  });
});
