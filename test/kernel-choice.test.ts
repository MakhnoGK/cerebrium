import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { chooseKernel } from "@/runtime/kernel-choice";
import { closeRpcConnections } from "@/runtime/rpc-client";
import { PROTOCOL_VERSION } from "@/core/rpc";
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

describe("A daemon that is alive but busy", () => {
  it("should wait it out rather than degrade to a second writer", async () => {
    // Given — nothing answering yet, and a pidfile saying a daemon is alive. Degrading
    // here costs a whole session on a second writable handle with no policy applied.
    let calls = 0;
    server = new RpcServer({
      initialize: () => {
        calls++;

        // The first handshake is never answered, the way a sweep holding the main thread
        // looks from here; the second one is.
        return calls === 1
          ? new Promise(() => undefined)
          : Promise.resolve({ protocol: PROTOCOL_VERSION });
      },
    });
    await server.listen(SOCKET);

    // When — a short first budget, then the long one because the daemon is alive.
    const choice = await chooseKernel(SOCKET, 20, () => true);

    // Then
    expect(choice).toMatchObject({ kernel: "remote" });
  });

  it("should still degrade quickly when no daemon owns the pidfile", async () => {
    // Given — nothing listening at all.
    const started = Date.now();

    // When
    const choice = await chooseKernel(SOCKET, 20, () => false);

    // Then — the short budget is the whole point for an absent daemon.
    expect(choice).toMatchObject({ kernel: "local", reason: "no daemon is listening" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("should not wait out a mismatch, which will still be a mismatch later", async () => {
    // Given
    server = new RpcServer({
      initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION + 1 }),
    });
    await server.listen(SOCKET);
    const started = Date.now();

    // When
    const choice = await chooseKernel(SOCKET, 750, () => true);

    // Then
    expect(choice).toMatchObject({ kernel: "local" });
    expect((choice as { reason: string }).reason).toMatch(/daemon unusable/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
