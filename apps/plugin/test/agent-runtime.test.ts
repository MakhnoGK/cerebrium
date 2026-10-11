import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNodeRuntime } from "@plugin/scripts/agent-runtime";

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
