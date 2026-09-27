import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "@/runtime/is-main";

const savedArgv1 = process.argv[1];
afterEach(() => {
  process.argv[1] = savedArgv1!;
});

describe("Main module detection", () => {
  it("should return true when the entry is a bin symlink pointing at the module (npm link case)", () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "mk-ismain-"));
    try {
      const real = join(realpathSync(dir), "stats-cli.js");
      writeFileSync(real, "// entry\n");
      const link = join(realpathSync(dir), "cerebrium-stats");
      symlinkSync(real, link);

      process.argv[1] = link; // invoked via the symlink

      // When / Then
      expect(isMainModule(pathToFileURL(real).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should return false when a different file is the entry", () => {
    // Given
    process.argv[1] = join(tmpdir(), "some-other-entry.js");

    // When / Then
    expect(isMainModule(pathToFileURL(join(tmpdir(), "not-it.js")).href)).toBe(false);
  });
});
