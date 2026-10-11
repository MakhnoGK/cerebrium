import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import { SessionService } from "@/application/services";
import { ClientIdentity, UNKNOWN_WRITER } from "@/runtime/client-identity";
import { SessionStartTool } from "@/presentation/mcp/tools/session-start";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

async function countSessions(env: TestEnv, id: string): Promise<number> {
  return (await env.sql.one<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM sessions WHERE id = @id",
    { id },
  ))!.c;
}

async function writerOf(env: TestEnv, id: string) {
  return env.sql.one("SELECT client, client_version FROM sessions WHERE id = @id", { id });
}

describe("SessionService", () => {
  it("should create a session only through startSession", async () => {
    const env = setup();
    const service = container.resolve(SessionService);

    await service.startSession(SESSION, "billing", env.clock.now(), UNKNOWN_WRITER);
    await service.startSession(SESSION, "billing", env.clock.now(), UNKNOWN_WRITER);

    expect(await countSessions(env, SESSION)).toBe(1);
  });

  it("should refresh last_seen for a known session", async () => {
    const env = setup();
    const service = container.resolve(SessionService);
    await service.startSession(SESSION, "billing", env.clock.now(), UNKNOWN_WRITER);
    env.clock.advanceDays(1);

    await service.requireSession(SESSION, env.clock.now());

    expect(
      await env.sql.one("SELECT last_seen FROM sessions WHERE id = @id", { id: SESSION }),
    ).toEqual({ last_seen: env.clock.now() });
  });

  it("should reject an unknown session without creating it", async () => {
    const env = setup();
    const service = container.resolve(SessionService);

    await expect(service.requireSession(UNKNOWN, env.clock.now())).rejects.toThrow(
      `Unknown session_id ${UNKNOWN}`,
    );
    expect(await countSessions(env, UNKNOWN)).toBe(0);
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
    expect(await writerOf(env, session_id)).toEqual({
      client: "claude-code",
      client_version: "1.2.3",
    });
  });

  it("should leave the writer null when nothing named itself", async () => {
    // Given
    const env = setup();
    container.resolve(ClientIdentity).set(UNKNOWN_WRITER);

    // When
    const { session_id } = await container.resolve(SessionStartTool).invoke({});

    // Then
    expect(await writerOf(env, session_id)).toEqual({ client: null, client_version: null });
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

    expect(await countSessions(env, UNKNOWN)).toBe(0);
    expect(await env.sql.one("SELECT COUNT(*)::int AS c FROM nodes")).toEqual({ c: 0 });
  });
});
