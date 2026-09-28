import { container } from "tsyringe";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BackendCapabilityError,
  PRINCIPAL_TOKENS_REPO_TOKEN,
  PRINCIPALS_REPO_TOKEN,
  STORE_TOKEN,
  type PrincipalsRepo,
  type PrincipalTokensRepo,
  type Store,
} from "@/domain/ports/storage";
import { PrincipalTokenService, TOKEN_RECHECK_MS } from "@/application/services";
import { setup, type TestEnv } from "@test/helpers";
import { TEST_BACKEND } from "@test/pg";

let env: TestEnv;
let tokens: PrincipalTokenService;

beforeEach(() => {
  env = setup();
  tokens = container.resolve(PrincipalTokenService);
});

describe.skipIf(TEST_BACKEND !== "postgres")("Principal tokens", () => {
  it("should authenticate an issued token as its principal", async () => {
    // Given
    const issued = await tokens.issue("mac-claude", "mac × claude-code");

    // When
    const found = await tokens.authenticate(issued.token);

    // Then
    expect(issued.token).toMatch(/^cbr_[A-Za-z0-9_-]{43}$/);
    expect(found).toEqual({ principal: "mac-claude", token_id: issued.id });
  });

  it("should register the principal a token is issued for", async () => {
    // Given / When
    await tokens.issue("mac-codex", "mac × codex");

    // Then
    const principal = await container
      .resolve<PrincipalsRepo>(PRINCIPALS_REPO_TOKEN)
      .find("mac-codex");
    expect(principal).toMatchObject({ id: "mac-codex", kind: "agent" });
  });

  it("should refuse a token nobody issued", async () => {
    // Given
    await tokens.issue("mac-claude", "mac × claude-code");

    // When / Then
    expect(await tokens.authenticate("cbr_forged")).toBeNull();
  });

  it("should never list or store the token itself", async () => {
    // Given
    const issued = await tokens.issue("mac-claude", "mac × claude-code");

    // When
    const listed = await tokens.list();

    // Then
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(listed).toEqual([
      expect.objectContaining({ id: issued.id, principal_id: "mac-claude", revoked_at: null }),
    ]);
  });

  it("should stop authenticating a revoked token once the recheck window passes", async () => {
    // Given
    const issued = await tokens.issue("mac-claude", "mac × claude-code");
    await tokens.authenticate(issued.token);

    // When
    const revoked = await tokens.revoke(issued.id);
    const within = await tokens.authenticate(issued.token);
    env.clock.advanceMs(TOKEN_RECHECK_MS);
    const after = await tokens.authenticate(issued.token);

    // Then
    expect(revoked).toBe(true);
    expect(within).not.toBeNull();
    expect(after).toBeNull();
  });

  it("should keep a revoked token's row", async () => {
    // Given
    const issued = await tokens.issue("mac-claude", "mac × claude-code");

    // When
    await tokens.revoke(issued.id);
    const again = await tokens.revoke(issued.id);

    // Then
    expect(again).toBe(false);
    expect(await tokens.list()).toEqual([
      expect.objectContaining({ id: issued.id, revoked_at: env.clock.now() }),
    ]);
  });

  it("should record when a token was last used, at most once a minute", async () => {
    // Given
    const issued = await tokens.issue("mac-claude", "mac × claude-code");
    const first = env.clock.now();

    // When
    await tokens.authenticate(issued.token);
    env.clock.advanceMs(TOKEN_RECHECK_MS);
    await container.resolve(PrincipalTokenService).authenticate(issued.token);
    const soon = (await tokens.list())[0]!.last_used_at;
    env.clock.advanceMs(TOKEN_RECHECK_MS);
    await tokens.authenticate(issued.token);
    const later = (await tokens.list())[0]!.last_used_at;

    // Then
    expect(soon).toBe(first);
    expect(later).toBe(env.clock.now());
  });

  it("should report the capability on the store", () => {
    // Given / When / Then
    expect(container.resolve<Store>(STORE_TOKEN).capabilities.principalTokens).toBe(true);
  });
});

describe.skipIf(TEST_BACKEND !== "sqlite")("Principal tokens on SQLite", () => {
  it("should refuse to issue or authenticate", async () => {
    // Given
    const repo = container.resolve<PrincipalTokensRepo>(PRINCIPAL_TOKENS_REPO_TOKEN);

    // When / Then
    await expect(tokens.issue("mac-claude", "x")).rejects.toBeInstanceOf(BackendCapabilityError);
    await expect(repo.findActiveByHash("x")).rejects.toBeInstanceOf(BackendCapabilityError);
    expect(container.resolve<Store>(STORE_TOKEN).capabilities.principalTokens).toBe(false);
  });
});
