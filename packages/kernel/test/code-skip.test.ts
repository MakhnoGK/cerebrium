import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walk } from "@/code/indexer";

const SRC = `export function ownWork(): number {
  return 1;
}
`;

let root: string;

function put(rel: string, body = SRC): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-skip-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("What the indexer refuses to walk", () => {
  it("should skip a third-party tree whatever the language", () => {
    // Given — Composer's tree is the one that put 98,748 framework symbols in the mirror
    put("src/own.ts");
    put("vendor/laravel/framework/src/Illuminate/Http/Client.php");
    put("application/vendor/ramsey/uuid/src/functions.php");

    // When
    const found = walk(root).map((c) => c.rel);

    // Then
    expect(found).toEqual(["src/own.ts"]);
  });

  it("should skip a generated IDE stub", () => {
    // Given
    put("src/own.ts");
    put("_ide_helper.php");
    put("application/_ide_helper_models.php");

    // When / Then
    expect(walk(root).map((c) => c.rel)).toEqual(["src/own.ts"]);
  });

  it("should still walk a directory whose name merely contains the word", () => {
    // Given — `vendor` is skipped as a whole path segment, not as a substring
    put("src/vendors/own.ts");
    put("src/vendor-api/own.ts");

    // When / Then
    expect(
      walk(root)
        .map((c) => c.rel)
        .sort(),
    ).toEqual(["src/vendor-api/own.ts", "src/vendors/own.ts"]);
  });
});
