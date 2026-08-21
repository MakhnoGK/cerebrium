import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityDeniedError, QuotaExceededError } from "@/application/errors";
import { ClientIdentity } from "@/runtime/client-identity";
import { pipelinedContainer } from "@/runtime/pipelined-kernel";
import { Capability, MemoryKind, Posture } from "@/core/vocab";
import { SearchTool } from "@/presentation/mcp/tools/search";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import {
  NEUTRAL_WEIGHT,
  OPEN_PROFILE,
  PrincipalsConfig,
  type PrincipalProfile,
  type PrincipalQuota,
} from "@/infrastructure/config";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;

function profile(
  capabilities: PrincipalProfile["capabilities"],
  quota: PrincipalQuota = {},
): PrincipalProfile {
  return { capabilities, quota, weight: NEUTRAL_WEIGHT };
}

// A host with no daemon resolves its tools from this scope, so a test that asserts on the
// local delivery path has to resolve them the same way.
function localScope(profiles: Record<string, PrincipalProfile> = {}, client = "codex-mcp-client") {
  container.register(PrincipalsConfig, { useValue: { profiles, default: OPEN_PROFILE } });
  container.resolve(ClientIdentity).set({ client, version: "1.0.0" });

  return pipelinedContainer(container);
}

function writeArgs(session_id: string, title = "A fact") {
  return {
    session_id,
    parent_node_id: null,
    memory_kind: MemoryKind.SEMANTIC,
    type: "fact",
    title,
    content: "a durable fact with enough words in it to make a chunk worth embedding",
  };
}

function rows(action: string): number {
  return (
    env.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action = ?").get(action) as { n: number }
  ).n;
}

function nodeCount(): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
}

beforeEach(() => {
  env = setup();
});

describe("Local mode delivery path", () => {
  it("should refuse a write the principal has no capability for", async () => {
    // Given
    const scope = localScope({
      "codex-mcp-client": profile({ [Capability.WRITE]: Posture.OFF }),
    });
    const { session_id } = await scope.resolve(SessionStartTool).invoke({});
    const before = nodeCount();

    // When / Then
    await expect(scope.resolve(WriteTool).invoke(writeArgs(session_id))).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
    expect(nodeCount()).toBe(before);
  });

  it("should leave the capabilities it did not revoke alone", async () => {
    // Given
    const scope = localScope({
      "codex-mcp-client": profile({ [Capability.WRITE]: Posture.OFF }),
    });
    const { session_id } = await scope.resolve(SessionStartTool).invoke({});

    // When / Then
    await expect(
      scope.resolve(SearchTool).invoke({ session_id, query: "anything", limit: 5 }),
    ).resolves.toBeDefined();
  });

  it("should permit everything when no principal is configured", async () => {
    // Given
    const scope = localScope();

    // When
    const { session_id } = await scope.resolve(SessionStartTool).invoke({});

    // Then
    await expect(scope.resolve(WriteTool).invoke(writeArgs(session_id))).resolves.toBeDefined();
  });

  it("should count a tool call against the principal's quota", async () => {
    // Given
    const scope = localScope({
      "codex-mcp-client": profile({}, { writes: 1, windowMs: 60_000 }),
    });
    const { session_id } = await scope.resolve(SessionStartTool).invoke({});
    const write = scope.resolve(WriteTool);

    // When
    await write.invoke(writeArgs(session_id, "The first fact"));

    // Then
    await expect(write.invoke(writeArgs(session_id, "The second fact"))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("should append exactly one audit row per tool call", async () => {
    // Given — the tool also calls `session_hints`, which carries `audit: false`.
    const scope = localScope();
    const { session_id } = await scope.resolve(SessionStartTool).invoke({});

    // When
    await scope.resolve(WriteTool).invoke(writeArgs(session_id));

    // Then
    expect(rows("write")).toBe(1);
    expect(rows("session_start")).toBe(1);
  });

  it("should attribute the session to the host's identity, not to an argument", async () => {
    // Given
    const scope = localScope({}, "claude-code");

    // When
    const { session_id } = await scope.resolve(SessionStartTool).invoke({});

    // Then
    const row = env.db
      .prepare("SELECT client, client_version, principal_id FROM sessions WHERE id = ?")
      .get(session_id) as { client: string; client_version: string; principal_id: string };

    expect(row.client).toBe("claude-code");
    expect(row.client_version).toBe("1.0.0");
    expect(row.principal_id).toBe("claude-code");
  });
});
