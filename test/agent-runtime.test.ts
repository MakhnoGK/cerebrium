import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeRuntime, resolveNodeRuntime } from "@scripts/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "agent-runtime-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("resolveNodeRuntime", () => {
  it("should return the canonical executable when the current Node matches .nvmrc", () => {
    // Given
    writeFileSync(join(repo, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);

    // When / Then
    expect(resolveNodeRuntime(repo)).toBe(realpathSync(process.execPath));
  });

  it("should fail closed when the current Node major differs", () => {
    // Given
    writeFileSync(join(repo, ".nvmrc"), "999\n");

    // When / Then
    expect(() => resolveNodeRuntime(repo)).toThrow("nvm use && npm install");
  });

  it("should fail closed for unsupported nvm aliases", () => {
    // Given
    writeFileSync(join(repo, ".nvmrc"), "lts/*\n");

    // When / Then
    expect(() => resolveNodeRuntime(repo)).toThrow("must contain a numeric Node version");
  });
});

describe("assertNativeRuntime", () => {
  it("should instantiate better-sqlite3 with the exact selected executable", () => {
    // Given
    mkdirSync(repo, { recursive: true });
    const probe = vi.fn();

    // When
    assertNativeRuntime(repo, "/runtime/node", probe);

    // Then
    expect(probe).toHaveBeenCalledWith(
      "/runtime/node",
      expect.arrayContaining(["-e", expect.stringContaining("new Database(':memory:')")]),
      { cwd: repo, stdio: "pipe" },
    );
  });

  it("should fail before apply when the native addon cannot load", () => {
    // Given
    const probe = vi.fn((): void => {
      throw new Error("ABI mismatch");
    });

    // When / Then
    expect(() => {
      assertNativeRuntime(repo, "/runtime/node", probe);
    }).toThrow("cannot load better-sqlite3");
  });
});
