import { rmSync } from "node:fs";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@cerebrium/contracts/rpc";
import { createDaemonMethods, RpcServer } from "@cerebrium/kernel/presentation/rpc";
import { checkHealth, healthProblem } from "@host/healthcheck";
import { setup } from "@test/helpers";

const SOCKET = `/tmp/cb-health-${String(process.pid)}.sock`;

let server: RpcServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("Health verdict (healthProblem)", () => {
  it("should call a daemon with a loaded model on this protocol healthy", () => {
    // Given
    const report = { protocol: PROTOCOL_VERSION, pid: 7, model: { state: "ready", ms: 900 } };

    // When / Then
    expect(healthProblem(report)).toBeNull();
  });

  it("should report a model that has not finished loading", () => {
    // Given
    const report = { protocol: PROTOCOL_VERSION, pid: 7, model: null };

    // When / Then
    expect(healthProblem(report)).toBe("model still loading");
  });

  it("should report a model that failed to load with its error", () => {
    // Given
    const report = {
      protocol: PROTOCOL_VERSION,
      pid: 7,
      model: { state: "failed", ms: 40, error: "no such file" },
    };

    // When / Then
    expect(healthProblem(report)).toBe("model failed: no such file");
  });

  it("should report a daemon on another protocol version", () => {
    // Given
    const report = { protocol: PROTOCOL_VERSION + 1, pid: 7, model: { state: "ready", ms: 1 } };

    // When / Then
    expect(healthProblem(report)).toContain(`protocol ${String(PROTOCOL_VERSION + 1)}`);
  });

  it("should report an answer that is not a health report", () => {
    // Given / When / Then
    expect(healthProblem(null)).toBe("no health report");
  });
});

describe("Health probe over the socket (checkHealth)", () => {
  beforeEach(() => {
    setup();
  });

  it("should pass against a daemon whose model is ready", async () => {
    // Given
    server = new RpcServer(
      createDaemonMethods(container, { pid: 11, model: () => ({ state: "ready", ms: 5 }) }),
    );
    await server.listen(SOCKET);

    // When / Then
    expect(await checkHealth(SOCKET)).toBeNull();
  });

  it("should fail when no daemon is listening", async () => {
    // Given / When
    const problem = await checkHealth(SOCKET);

    // Then
    expect(problem).not.toBeNull();
  });
});
