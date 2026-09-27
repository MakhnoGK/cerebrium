import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cerebriumHome, configFilePath, defaultDbPath, modelsDir } from "@/runtime/paths";

describe("Install layout", () => {
  it("should default the home to ~/.cerebrium", () => {
    // Given / When / Then
    expect(cerebriumHome({})).toBe(join(homedir(), ".cerebrium"));
  });

  it("should move every derived path together when CEREBRIUM_HOME is set", () => {
    // Given
    const env = { CEREBRIUM_HOME: "/opt/brain" };

    // When / Then
    expect(configFilePath(env)).toBe("/opt/brain/config.json");
    expect(defaultDbPath(env)).toBe("/opt/brain/memory.db");
    expect(modelsDir(env)).toBe("/opt/brain/models");
  });

  it("should treat a blank CEREBRIUM_HOME as unset", () => {
    // Given / When / Then
    expect(cerebriumHome({ CEREBRIUM_HOME: "   " })).toBe(join(homedir(), ".cerebrium"));
  });
});
