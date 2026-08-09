import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { SessionService } from "@/application/services";
import { ClientIdentity, UNKNOWN_WRITER } from "@/runtime/client-identity";
import { MemoryKind } from "@/core/vocab";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function countSessions(env: TestEnv, id: string): number {
  return (
    env.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = ?").get(id) as { c: number }
  ).c;
}

describe("SessionService", () => {
  it("should create a session only through startSession", () => {
    const env = setup();
    const service = container.resolve(SessionService);

    service.startSession(SESSION, "billing", env.clock.now(), UNKNOWN_WRITER);
    service.startSession(SESSION, "billing", env.clock.now(), UNKNOWN_WRITER);

    expect(countSessions(env, SESSION)).toBe(1);
  });

  it("should refresh last_seen for a known session", () => {
    const env = setup();
    const service = container.resolve(SessionService);
    service.startSession(SESSION, "billing", env.clock.now(), UNKNOWN_WRITER);
    env.clock.advanceDays(1);

    service.requireSession(SESSION, env.clock.now());

    expect(
      env.db.prepare("SELECT last_seen FROM sessions WHERE id = ?").get(SESSION),
    ).toStrictEqual({ last_seen: env.clock.now() });
  });

  it("should reject an unknown session without creating it", () => {
    const env = setup();
    const service = container.resolve(SessionService);

    expect(() => {
      service.requireSession(UNKNOWN, env.clock.now());
    }).toThrow(`Unknown session_id ${UNKNOWN}`);
    expect(countSessions(env, UNKNOWN)).toBe(0);
  });
});

describe("Writer identity", () => {
  it("should record the client the handshake named on a session it mints", async () => {
    // Given
    const env = setup();
    container.resolve(ClientIdentity).set({ client: "claude-code", version: "1.2.3" });

    // When
    const { session_id } = await container.resolve(SessionStartTool).invoke({});

    // Then
    expect(
      env.db.prepare("SELECT client, client_version FROM sessions WHERE id = ?").get(session_id),
    ).toStrictEqual({ client: "claude-code", client_version: "1.2.3" });
  });

  it("should leave the writer null when nothing named itself", async () => {
    // Given
    const env = setup();
    container.resolve(ClientIdentity).set(UNKNOWN_WRITER);

    // When
    const { session_id } = await container.resolve(SessionStartTool).invoke({});

    // Then
    expect(
      env.db.prepare("SELECT client, client_version FROM sessions WHERE id = ?").get(session_id),
    ).toStrictEqual({ client: null, client_version: null });
  });
});

describe("Direct tool calls", () => {
  it("should reject an unknown session before a write changes memory", async () => {
    const env = setup();
    const write = container.resolve(WriteTool);

    await expect(
      write.invoke({
        session_id: UNKNOWN,
        parent_node_id: null,
        memory_kind: MemoryKind.SEMANTIC,
        type: "fact",
        title: "Refund policy",
        content: "A refund can be issued within thirty days of purchase.",
        project: "billing",
      }),
    ).rejects.toThrow(`Unknown session_id ${UNKNOWN}`);

    expect(countSessions(env, UNKNOWN)).toBe(0);
    expect((env.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c).toBe(0);
  });
});
