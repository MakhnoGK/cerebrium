import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrincipalTokenService } from "@cerebrium/kernel/application/services";
import { buildContainer } from "@cerebrium/kernel/container";
import { StaticConfigSource } from "@cerebrium/kernel/infrastructure/config";
import { runTokenCommand, tokenCli, type TokenIo } from "@host/token-cli";
import { setup } from "@test/helpers";
import { TEST_BACKEND } from "@test/pg";

let tokens: PrincipalTokenService;
let dir: string;

function capture(): TokenIo & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out: (text: string) => {
      io.stdout += text;
    },
    err: (text: string) => {
      io.stderr += text;
    },
  };

  return io;
}

beforeEach(() => {
  setup();
  tokens = container.resolve(PrincipalTokenService);
  dir = mkdtempSync(join(tmpdir(), "cb-tokcli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(TEST_BACKEND !== "postgres")("Token CLI", () => {
  it("should print only the token on stdout when there is no --out", async () => {
    // Given
    const io = capture();

    // When
    const code = await runTokenCommand(
      ["issue", "--principal", "mac-claude", "--label", "mac × claude-code"],
      tokens,
      io,
    );

    // Then
    expect(code).toBe(0);
    expect(io.stdout).toMatch(/^cbr_\S+\n$/);
    expect(io.stderr).toMatch(/^issued token \S+ for mac-claude \(mac × claude-code\)\n$/);
    expect(await tokens.authenticate(io.stdout.trim())).toMatchObject({ principal: "mac-claude" });
  });

  it("should write the token to a new 0600 file with --out", async () => {
    // Given
    const io = capture();
    const out = join(dir, "host-token");

    // When
    const code = await runTokenCommand(
      ["issue", "--principal", "mac-claude", "--label", "l", "--out", out],
      tokens,
      io,
    );

    // Then
    expect(code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(io.stdout).not.toContain(readFileSync(out, "utf8").trim());
  });

  it("should refuse to overwrite an existing --out file", async () => {
    // Given
    const out = join(dir, "host-token");
    writeFileSync(out, "keep");

    // When
    const run = runTokenCommand(
      ["issue", "--principal", "mac-claude", "--label", "l", "--out", out],
      tokens,
      capture(),
    );

    // Then
    await expect(run).rejects.toThrow(/EEXIST/);
    expect(readFileSync(out, "utf8")).toBe("keep");
  });

  it("should list tokens without their values and revoke one by id", async () => {
    // Given
    const issued = await tokens.issue("mac-claude", "mac × claude-code");
    const io = capture();

    // When
    const revoked = await runTokenCommand(["revoke", issued.id], tokens, io);
    await runTokenCommand(["list"], tokens, io);

    // Then
    expect(revoked).toBe(0);
    expect(io.stdout).toContain(`revoked ${issued.id}\n`);
    expect(io.stdout).toMatch(
      new RegExp(`${issued.id}  mac-claude  mac × claude-code  .*revoked `),
    );
    expect(io.stdout).not.toContain(issued.token);
  });

  it("should fail on an unknown id and on missing arguments", async () => {
    // Given
    const io = capture();

    // When
    const unknown = await runTokenCommand(["revoke", "01AAAAAAAAAAAAAAAAAAAAAAAA"], tokens, io);
    const missing = await runTokenCommand(["issue", "--principal", "x"], tokens, io);

    // Then
    expect(unknown).toBe(1);
    expect(missing).toBe(2);
    expect(await tokens.list()).toEqual([]);
  });
});

describe("Token CLI entry", () => {
  it("should refuse a non-postgres store before opening it", async () => {
    // Given
    const io = capture();
    const db = join(dir, "never-created.db");
    const build = () =>
      buildContainer({
        role: "server",
        into: container.createChildContainer(),
        source: new StaticConfigSource({ MEMORY_STORE_BACKEND: "sqlite", MEMORY_DB_PATH: db }),
      });

    // When
    const code = await tokenCli(["list"], io, build);

    // Then
    expect(code).toBe(1);
    expect(io.stderr).toContain("need the postgres store");
    expect(existsSync(db)).toBe(false);
  });
});
