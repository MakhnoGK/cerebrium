import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chooseKernel } from "@/runtime/kernel-choice";
import { closeRpcConnections } from "@/runtime/rpc-client";
import { PROTOCOL_VERSION } from "@/core/rpc";
import { GuardedToolWrapper, PassThroughToolWrapper } from "@/presentation/mcp/adapters";
import type { McpTool } from "@/presentation/mcp/tools/contracts";
import { RpcServer } from "@/presentation/rpc";

const SOCKET = `/tmp/cb-choice-${String(process.pid)}.sock`;

let server: RpcServer | null = null;

afterEach(async () => {
  closeRpcConnections();
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("Choosing a kernel", () => {
  it("should choose remote when a daemon answers the handshake", async () => {
    // Given
    server = new RpcServer({
      initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION }),
    });
    await server.listen(SOCKET);

    // When / Then
    await expect(chooseKernel(SOCKET)).resolves.toEqual({
      kernel: "remote",
      protocol: PROTOCOL_VERSION,
    });
  });

  it("should degrade to local when nothing is listening", async () => {
    // Given / When
    const choice = await chooseKernel("/tmp/cb-choice-absent.sock");

    // Then — a missing daemon is ordinary and must not stop the host from starting.
    expect(choice).toEqual({ kernel: "local", reason: "no daemon is listening" });
  });

  it("should degrade to local but say so loudly on a protocol mismatch", async () => {
    // Given — a resident daemon serving an older build.
    server = new RpcServer({
      initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION + 1 }),
    });
    await server.listen(SOCKET);

    // When
    const choice = await chooseKernel(SOCKET);

    // Then — still local, but the reason distinguishes it from an absent daemon, because
    // somebody has to know to restart the thing.
    expect(choice.kernel).toBe("local");
    expect(choice).toMatchObject({ reason: expect.stringMatching(/daemon unusable/) });
  });

  it("should give up inside its budget rather than making the client wait", async () => {
    // Given — a daemon that accepts the connection and never answers, which is worse than
    // one that is down: a stdio host has a startup deadline.
    server = new RpcServer({ initialize: () => new Promise(() => undefined) });
    await server.listen(SOCKET);

    // When
    const started = Date.now();
    const choice = await chooseKernel(SOCKET, 200);

    // Then
    expect(choice.kernel).toBe("local");
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("Tool wrapping per kernel", () => {
  const tool = { getMetadata: () => ({ name: "x" }) } as unknown as McpTool<never, unknown>;

  it("should not wrap when the daemon already guarded and audited the call", () => {
    // Given / When
    const wrapped = new PassThroughToolWrapper().wrap(tool);

    // Then — wrapping again would validate the session twice and write two events rows.
    expect(wrapped).toBe(tool);
  });

  it("should wrap when this host is the one holding the database", () => {
    // Given
    const events = { invoke: () => Promise.resolve({}) };
    const sessions = { invoke: () => Promise.resolve({}) };

    // When
    const wrapped = new GuardedToolWrapper(events, sessions).wrap(tool);

    // Then
    expect(wrapped).not.toBe(tool);
  });
});
