import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { Capability, MemoryKind, Posture } from "@cerebrium/contracts/vocab";
import type { Writer } from "@/domain/writer";
import { CallPipeline } from "@/application/call-pipeline";
import { CapabilityDeniedError } from "@/application/errors";
import { SubscriptionService } from "@/application/services";
import { NotificationTopic } from "@/application/use-cases";
import { NEUTRAL_WEIGHT, OPEN_PROFILE, PrincipalsConfig } from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let pipeline: CallPipeline;

const pinned = (principal: string, client = "claude-code"): Writer => ({
  client,
  version: "1.0.0",
  principal,
});

async function start(writer: Writer): Promise<string> {
  const started = (await pipeline.invoke(container, "start_session", {}, writer)) as {
    session_id: string;
  };

  return started.session_id;
}

function write(session_id: string): Record<string, unknown> {
  return {
    session_id,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title: "A pinned fact",
    content: "a durable fact with enough words in it to make a chunk worth embedding",
  };
}

beforeEach(() => {
  env = setup();
  container.register(PrincipalsConfig, {
    useValue: {
      profiles: {
        "mac-codex": {
          capabilities: { [Capability.WRITE]: Posture.OFF },
          quota: {},
          weight: NEUTRAL_WEIGHT,
        },
      },
      default: OPEN_PROFILE,
    },
  });
  container.resolve(SubscriptionService).subscribe("mac-claude", []);
  pipeline = container.resolve(CallPipeline);
});

describe("Token-pinned principal", () => {
  it("should attribute the session to the pinned principal, not the client name", async () => {
    // Given / When
    const session = await start(pinned("mac-claude"));

    // Then
    expect(await env.sessions.principalOf(session)).toBe("mac-claude");
  });

  it("should apply the pinned principal's policy whatever the client calls itself", async () => {
    // Given
    const session = await start(pinned("mac-codex", "mac-claude"));

    // When / Then
    await expect(
      pipeline.invoke(container, "write_memory", write(session), pinned("mac-codex", "mac-claude")),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("should refuse a session that belongs to another principal", async () => {
    // Given
    const theirs = await start(pinned("mac-codex"));

    // When / Then
    await expect(
      pipeline.invoke(container, "write_memory", write(theirs), pinned("mac-claude")),
    ).rejects.toThrow(/belongs to another principal/);
  });

  it("should keep accepting any known session from an unpinned caller", async () => {
    // Given
    const theirs = await start(pinned("mac-claude"));

    // When / Then
    await expect(
      pipeline.invoke(container, "write_memory", write(theirs), {
        client: "claude-code",
        version: null,
      }),
    ).resolves.toBeDefined();
  });

  it("should subscribe the pinned principal rather than the process identity", async () => {
    // Given
    const session = await start(pinned("mac-claude"));

    // When
    await pipeline.invoke(
      container,
      "subscribe_events",
      { session_id: session, topics: [NotificationTopic.CONSOLIDATION] },
      pinned("mac-claude"),
    );

    // Then
    const subscriptions = container.resolve(SubscriptionService);
    expect(subscriptions.wants("mac-claude", NotificationTopic.CONSOLIDATION)).toBe(true);
    expect(subscriptions.wants("claude-code", NotificationTopic.CONSOLIDATION)).toBe(false);
  });
});
