import { rmSync } from "node:fs";
import { container } from "tsyringe";
import { afterEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { CapabilityDeniedError } from "@/application/errors";
import { SubscriptionService } from "@/application/services";
import { NotificationTopic } from "@/application/use-cases";
import { ClientIdentity } from "@/runtime/client-identity";
import { closeRpcConnections, onRpcNotification, rpcCall } from "@/runtime/rpc-client";
import { Capability, Posture } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { RpcServer } from "@/presentation/rpc";
import { NEUTRAL_WEIGHT, OPEN_PROFILE, PrincipalsConfig } from "@/infrastructure/config";
import { setup } from "@test/helpers";

const SOCKET = `/tmp/cb-subs-${String(process.pid)}.sock`;

let server: RpcServer | null = null;

afterEach(async () => {
  closeRpcConnections();
  await server?.close();
  server = null;
  rmSync(SOCKET, { force: true });
});

describe("Subscription registry", () => {
  it("should record interest against the principal, not the connection", () => {
    // Given — a dropped connection is ordinary; the same principal reconnecting is the
    // same subscriber.
    const subs = new SubscriptionService();

    // When
    subs.subscribe("cerebrium-ui", [NotificationTopic.CONSOLIDATION]);

    // Then
    expect(subs.wants("cerebrium-ui", NotificationTopic.CONSOLIDATION)).toBe(true);
    expect(subs.wants("claude-code", NotificationTopic.CONSOLIDATION)).toBe(false);
  });

  it("should treat an empty topic list as unsubscribing", () => {
    // Given
    const subs = new SubscriptionService();
    subs.subscribe("cerebrium-ui", [NotificationTopic.CONSOLIDATION]);

    // When
    expect(subs.subscribe("cerebrium-ui", [])).toEqual([]);

    // Then
    expect(subs.wants("cerebrium-ui", NotificationTopic.CONSOLIDATION)).toBe(false);
    expect(subs.subscribers).toBe(0);
  });
});

describe("Subscribing through the call surface", () => {
  it("should be refused when the principal may not read", async () => {
    // Given — `subscribe_events` is a call like any other, so S2's posture applies to it
    // without the transport knowing anything about policy.
    setup();
    container.register(PrincipalsConfig, {
      useValue: {
        profiles: {
          "codex-mcp-client": {
            capabilities: { [Capability.READ]: Posture.OFF },
            quota: {},
            weight: NEUTRAL_WEIGHT,
          },
        },
        default: OPEN_PROFILE,
      },
    });
    container.resolve(ClientIdentity).set({ client: "codex-mcp-client", version: null });

    const pipeline = container.resolve(CallPipeline);
    const { session_id } = await container.resolve(SessionStartTool).invoke({});

    // When / Then
    await expect(
      pipeline.invoke(
        container,
        "subscribe_events",
        { session_id, topics: [NotificationTopic.CONSOLIDATION] },
        { client: "codex-mcp-client", version: null },
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });
});

describe("Routing a notification", () => {
  it("should reach only the connection whose principal asked for the topic", async () => {
    // Given — two connections is one socket path in this process, so the identity is
    // asserted through what the server recorded from `meta`.
    const subs = new SubscriptionService();
    server = new RpcServer({ ping: () => Promise.resolve({ ok: true }) });
    await server.listen(SOCKET);

    const heard: { method: string; params: Record<string, unknown> }[] = [];
    onRpcNotification(SOCKET, (method, params) => {
      heard.push({ method, params });
    });

    // The connection names itself by making a call, which is how the server learns who it is
    await rpcCall({ socketPath: SOCKET }, "ping", {}, { client: "cerebrium-ui", version: "1" });

    // When — nobody has subscribed yet
    expect(
      server.notify("consolidation.swept", { links_added: 1 }, (client) =>
        subs.wants(client, NotificationTopic.CONSOLIDATION),
      ),
    ).toBe(0);

    subs.subscribe("cerebrium-ui", [NotificationTopic.CONSOLIDATION]);

    // Then
    expect(
      server.notify("consolidation.swept", { links_added: 1 }, (client) =>
        subs.wants(client, NotificationTopic.CONSOLIDATION),
      ),
    ).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(heard).toEqual([{ method: "consolidation.swept", params: { links_added: 1 } }]);
  });

  it("should reach nobody when the subscriber's principal never called", async () => {
    // Given — a connection that has not identified itself is not the subscriber
    const subs = new SubscriptionService();
    subs.subscribe("cerebrium-ui", [NotificationTopic.CONSOLIDATION]);
    server = new RpcServer({ ping: () => Promise.resolve({ ok: true }) });
    await server.listen(SOCKET);

    await rpcCall({ socketPath: SOCKET }, "ping", {}, { client: null, version: null });

    // When / Then
    expect(
      server.notify("consolidation.swept", {}, (client) =>
        subs.wants(client, NotificationTopic.CONSOLIDATION),
      ),
    ).toBe(0);
  });
});
