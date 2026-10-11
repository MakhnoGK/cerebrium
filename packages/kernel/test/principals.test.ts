import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import { PrincipalKind, UNATTRIBUTED_PRINCIPAL } from "@cerebrium/contracts/vocab";
import { PRINCIPALS_REPO_TOKEN, type PrincipalsRepo } from "@/domain/ports/storage";
import { CallPipeline } from "@/application/call-pipeline";
import { setup, type TestEnv } from "@test/helpers";

let env: TestEnv;
let pipeline: CallPipeline;

async function startSession(client: string | null, version: string | null = null) {
  const result = (await pipeline.invoke(container, "start_session", {}, { client, version })) as {
    session_id: string;
  };

  return result.session_id;
}

async function principalOf(session_id: string): Promise<string | null | undefined> {
  const row = await env.sql.one<{ principal_id: string | null }>(
    "SELECT principal_id FROM sessions WHERE id = @id",
    { id: session_id },
  );

  return row?.principal_id;
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
    expect(await principalOf(session)).toBe("claude-code");
    expect(
      await container.resolve<PrincipalsRepo>(PRINCIPALS_REPO_TOKEN).find("claude-code"),
    ).toMatchObject({
      id: "claude-code",
      kind: PrincipalKind.AGENT,
    });
  });

  it("should give two sessions from one client the same principal", async () => {
    // Given / When — the point of a principal is that it outlives the session.
    const first = await startSession("codex-mcp-client", "0.147.0");
    const second = await startSession("codex-mcp-client", "0.148.0");

    // Then
    expect(await principalOf(first)).toBe(await principalOf(second));
    expect(await container.resolve<PrincipalsRepo>(PRINCIPALS_REPO_TOKEN).list()).toHaveLength(1);
  });

  it("should resolve a host that never named itself to a principal that can still be addressed", async () => {
    // Given / When — silence must land somewhere a rule can name, not outside every rule.
    const session = await startSession(null);

    // Then
    expect(await principalOf(session)).toBe(UNATTRIBUTED_PRINCIPAL);
    expect(
      await container.resolve<PrincipalsRepo>(PRINCIPALS_REPO_TOKEN).find(UNATTRIBUTED_PRINCIPAL),
    ).toMatchObject({
      kind: PrincipalKind.UNATTRIBUTED,
    });
  });

  it("should classify the system's own writers apart from agent hosts", async () => {
    // Given / When
    await startSession("cerebrium-consolidation");
    await startSession("antigravity-client");

    // Then
    const repo = container.resolve<PrincipalsRepo>(PRINCIPALS_REPO_TOKEN);
    expect((await repo.find("cerebrium-consolidation"))?.kind).toBe(PrincipalKind.SYSTEM);
    expect((await repo.find("antigravity-client"))?.kind).toBe(PrincipalKind.AGENT);
  });
});
