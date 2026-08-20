import { createRequire } from "node:module";
import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { CallPipeline } from "@/application/call-pipeline";
import { PrincipalsRepo } from "@/db/repositories";
import { PrincipalKind, UNATTRIBUTED_PRINCIPAL } from "@/core/vocab";
import { setup, type TestEnv } from "@test/helpers";

const require = createRequire(import.meta.url);
const { up } = require("../src/db/migrations/024_principals.cjs") as {
  up: (db: import("better-sqlite3").Database) => void;
};

let env: TestEnv;
let pipeline: CallPipeline;

async function startSession(client: string | null, version: string | null = null) {
  const result = (await pipeline.invoke(container, "start_session", {}, { client, version })) as {
    session_id: string;
  };

  return result.session_id;
}

function principalOf(session_id: string): string | null {
  const row = env.db.prepare("SELECT principal_id FROM sessions WHERE id = ?").get(session_id) as {
    principal_id: string | null;
  };

  return row.principal_id;
}

beforeEach(() => {
  env = setup();
  pipeline = container.resolve(CallPipeline);
});

describe("Principals", () => {
  it("should attach a session to the principal named by its writer", async () => {
    // Given / When
    const session = await startSession("claude-code", "2.1.224");

    // Then
    expect(principalOf(session)).toBe("claude-code");
    expect(container.resolve(PrincipalsRepo).find("claude-code")).toMatchObject({
      id: "claude-code",
      kind: PrincipalKind.AGENT,
    });
  });

  it("should give two sessions from one client the same principal", async () => {
    // Given / When — the point of a principal is that it outlives the session.
    const first = await startSession("codex-mcp-client", "0.147.0");
    const second = await startSession("codex-mcp-client", "0.148.0");

    // Then
    expect(principalOf(first)).toBe(principalOf(second));
    expect(container.resolve(PrincipalsRepo).list()).toHaveLength(1);
  });

  it("should resolve a host that never named itself to a principal that can still be addressed", async () => {
    // Given / When — silence must land somewhere a rule can name, not outside every rule.
    const session = await startSession(null);

    // Then
    expect(principalOf(session)).toBe(UNATTRIBUTED_PRINCIPAL);
    expect(container.resolve(PrincipalsRepo).find(UNATTRIBUTED_PRINCIPAL)).toMatchObject({
      kind: PrincipalKind.UNATTRIBUTED,
    });
  });

  it("should classify the system's own writers apart from agent hosts", async () => {
    // Given / When
    await startSession("cerebrium-consolidation");
    await startSession("antigravity-client");

    // Then
    const repo = container.resolve(PrincipalsRepo);
    expect(repo.find("cerebrium-consolidation")?.kind).toBe(PrincipalKind.SYSTEM);
    expect(repo.find("antigravity-client")?.kind).toBe(PrincipalKind.AGENT);
  });
});

describe("Principal backfill", () => {
  it("should adopt sessions written before principals existed", () => {
    // Given — rows as migration 020 left them: a client, and no principal.
    const insert = env.db.prepare(
      "INSERT INTO sessions (id, project, started_at, last_seen, client, client_version) VALUES (?, NULL, ?, ?, ?, ?)",
    );
    insert.run(
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
      "claude-code",
      "2.1.220",
    );
    insert.run(
      "01BBBBBBBBBBBBBBBBBBBBBBBB",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "claude-code",
      "2.1.224",
    );
    insert.run(
      "01CCCCCCCCCCCCCCCCCCCCCCCC",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      null,
      null,
    );

    // When
    up(env.db);

    // Then
    expect(principalOf("01AAAAAAAAAAAAAAAAAAAAAAAA")).toBe("claude-code");
    expect(principalOf("01BBBBBBBBBBBBBBBBBBBBBBBB")).toBe("claude-code");
    expect(principalOf("01CCCCCCCCCCCCCCCCCCCCCCCC")).toBe(UNATTRIBUTED_PRINCIPAL);
  });

  it("should date a backfilled principal from the sessions it is inferred from", () => {
    // Given
    env.db
      .prepare(
        "INSERT INTO sessions (id, project, started_at, last_seen, client, client_version) VALUES (?, NULL, ?, ?, ?, NULL)",
      )
      .run(
        "01DDDDDDDDDDDDDDDDDDDDDDDD",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z",
        "codex-mcp-client",
      );
    env.db
      .prepare(
        "INSERT INTO sessions (id, project, started_at, last_seen, client, client_version) VALUES (?, NULL, ?, ?, ?, NULL)",
      )
      .run(
        "01EEEEEEEEEEEEEEEEEEEEEEEE",
        "2026-08-15T00:00:00.000Z",
        "2026-08-15T00:00:00.000Z",
        "codex-mcp-client",
      );

    // When
    up(env.db);

    // Then
    expect(container.resolve(PrincipalsRepo).find("codex-mcp-client")).toMatchObject({
      created_at: "2026-07-14T00:00:00.000Z",
      last_seen: "2026-08-15T00:00:00.000Z",
    });
  });

  it("should leave an already-attached session alone when it runs again", () => {
    // Given — migrations re-run when a ledger row goes missing, so this has to be safe.
    env.db
      .prepare(
        "INSERT INTO sessions (id, project, started_at, last_seen, client, client_version, principal_id) VALUES (?, NULL, ?, ?, ?, NULL, ?)",
      )
      .run(
        "01FFFFFFFFFFFFFFFFFFFFFFFF",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "claude-code",
        "pinned-elsewhere",
      );

    // When
    up(env.db);

    // Then
    expect(principalOf("01FFFFFFFFFFFFFFFFFFFFFFFF")).toBe("pinned-elsewhere");
  });
});
