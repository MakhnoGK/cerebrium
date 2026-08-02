import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import { SessionService } from "@/application/services";
import { MemoryKind } from "@/core/vocab";
import { WriteTool } from "@/presentation/mcp/tools/write";
import { setup, TestEnv } from "@test/helpers";

const UNKNOWN = "01SESSIONNEVERSTARTED000000";

function countSessions(env: TestEnv, id: string): number {
  return (
    env.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = ?").get(id) as { c: number }
  ).c;
}

describe("SessionService.ensureSession", () => {
  it("should report created exactly once when the same unknown id arrives repeatedly", () => {
    // Given
    const env = setup();
    const service = container.resolve(SessionService);
    const now = env.clock.now();

    // When
    const results = [
      service.ensureSession(UNKNOWN, "billing", now),
      service.ensureSession(UNKNOWN, "billing", now),
      service.ensureSession(UNKNOWN, "billing", now),
    ];

    // Then
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(countSessions(env, UNKNOWN)).toBe(1);
  });

  it("should refresh last_seen without re-creating when the session already exists", () => {
    // Given
    const env = setup();
    const service = container.resolve(SessionService);
    const first = service.ensureSession(UNKNOWN, "billing", env.clock.now());

    // When
    env.clock.advanceDays(1);

    const second = service.ensureSession(UNKNOWN, "billing", env.clock.now());

    // Then
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(
      env.db.prepare("SELECT last_seen FROM sessions WHERE id = ?").get(UNKNOWN),
    ).toStrictEqual({ last_seen: env.clock.now() });
  });
});

// Every tool schema advertises session_id as "auto-created if unknown", and the MCP server
// serves queued requests concurrently — so two tool calls really can carry the same unknown
// id at once. This is the shape that failed in production with a UNIQUE violation.
describe("Concurrent tool calls on an unknown session", () => {
  it("should serve both writes when two of them carry the same unknown session id", async () => {
    // Given
    const env = setup();
    const write = container.resolve(WriteTool);
    const fact = (title: string) => ({
      session_id: UNKNOWN,
      memory_kind: MemoryKind.SEMANTIC,
      type: "fact",
      title,
      content: "a refund can be issued within thirty days of purchase",
      project: "billing",
    });

    // When
    const both = await Promise.all([
      write.invoke(fact("Refund A")),
      write.invoke(fact("Refund B")),
    ]);

    // Then
    expect(both.map((r) => r.title)).toStrictEqual(["Refund A", "Refund B"]);
    expect(countSessions(env, UNKNOWN)).toBe(1);
  });
});
