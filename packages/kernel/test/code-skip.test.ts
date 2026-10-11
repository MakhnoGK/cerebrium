import { describe, expect, it } from "vitest";
import { isIndexablePath } from "@cerebrium/contracts/code";

describe("What the code index refuses to read", () => {
  it("should skip a third-party tree whatever the language", () => {
    // Given / When / Then
    expect(isIndexablePath("src/own.ts")).toBe(true);
    expect(isIndexablePath("vendor/laravel/framework/src/Illuminate/Http/Client.php")).toBe(false);
    expect(isIndexablePath("application/vendor/ramsey/uuid/src/functions.php")).toBe(false);
  });

  it("should skip a generated IDE stub", () => {
    // Given / When / Then
    expect(isIndexablePath("_ide_helper.php")).toBe(false);
    expect(isIndexablePath("application/_ide_helper_models.php")).toBe(false);
  });

  it("should still read a directory whose name merely contains the word", () => {
    // Given / When / Then
    expect(isIndexablePath("src/vendors/own.ts")).toBe(true);
    expect(isIndexablePath("src/vendor-api/own.ts")).toBe(true);
  });
});
