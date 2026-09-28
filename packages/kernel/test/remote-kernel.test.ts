import { rmSync } from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
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
import { DaemonUnreachableError } from "@/runtime/remote-kernel";
import { closeRpcConnections } from "@/runtime/rpc-client";
import { RpcServer, surfaceMethods } from "@/presentation/rpc";
import { buildContainer, KERNEL_TOKENS } from "@/container";
import { StaticConfigSource } from "@/infrastructure/config";

const SOCKET = `/tmp/cb-remote-${String(process.pid)}.sock`;

let server: RpcServer | null = null;

async function dropEveryRequest(): Promise<NetServer> {
  const raw = createServer((socket) => {
    socket.once("data", () => socket.destroy());
  });

  await new Promise<void>((resolve) => raw.listen(SOCKET, resolve));

  return raw;
}

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
  closeRpcConnections();
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

  it("should tell a read caller it is safe to retry when the daemon drops the call", async () => {
    // Given
    const drops = await dropEveryRequest();
    const search = remote().resolve<SearchMemory>(SEARCH_MEMORY);

    // When / Then
    await expect(search.invoke({ query: "x", limit: 1 })).rejects.toThrow(
      /did not answer search_memory.*This is a read: retry it/,
    );
    drops.close();
  });

  it("should warn a write caller that repeating a dropped call could duplicate the change", async () => {
    // Given
    const drops = await dropEveryRequest();
    const write = remote().resolve<WriteMemory>(WRITE_MEMORY);

    // When / Then
    await expect(
      write.invoke({ session_id: "01JJJJJJJJJJJJJJJJJJJJJJJJ" } as never),
    ).rejects.toThrow(/may or may not have been applied/);
    drops.close();
  });

  it("should tell a write caller that nothing was sent when the daemon cannot be reached", async () => {
    // Given
    const write = remote().resolve<WriteMemory>(WRITE_MEMORY);

    // When
    const failure = write.invoke({ session_id: "01JJJJJJJJJJJJJJJJJJJJJJJJ" } as never);

    // Then
    await expect(failure).rejects.toThrow(
      new RegExp(`could not reach the memory daemon at ${SOCKET} for write_memory`),
    );
    await expect(failure).rejects.toThrow(/Nothing was sent, so repeating the call is safe/);
    await expect(failure).rejects.toMatchObject({ sent: false });
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
    await expect(failure).rejects.not.toBeInstanceOf(DaemonUnreachableError);
  });
});
