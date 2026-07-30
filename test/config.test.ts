import { container } from "tsyringe";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SOURCE_TOKEN,
  ConfigError,
  configSection,
  derivedEnvName,
  enumOf,
  int,
  nullableStr,
  num,
  sectionMeta,
  SectionOf,
  str,
} from "@/domain/ports/config";
import { Posture } from "@/core/vocab";
import { ConfigRegistry, StaticConfigSource } from "@/infrastructure/config";

const SPEC = {
  symbolWeight: num(0.5).positive().env("MEMORY_SYMBOL_WEIGHT"),
  dedupThreshold: num(0.82).range(0, 1),
  workingSetTokens: int(1500).positive(),
  model: str("e5-small"),
  command: nullableStr(null),
  posture: enumOf(Posture, Posture.AUTO),
};

class RetrievalConfig extends SectionOf("retrieval", SPEC) {}

function build(values: Record<string, string | undefined> = {}): RetrievalConfig {
  return new RetrievalConfig(new StaticConfigSource(values));
}

describe("Env-var naming", () => {
  it("should derive a MEMORY_-prefixed snake-case name from the config path", () => {
    // Given / When / Then
    expect(derivedEnvName("retrieval.symbolWeight")).toBe("MEMORY_RETRIEVAL_SYMBOL_WEIGHT");
    expect(derivedEnvName("consolidation.batch.link")).toBe("MEMORY_CONSOLIDATION_BATCH_LINK");
  });

  it("should use the pinned legacy name when a field declares one", () => {
    // Given / When
    const cfg = build({ MEMORY_SYMBOL_WEIGHT: "0.01" });

    // Then
    expect(cfg.symbolWeight).toBe(0.01);
  });

  it("should ignore the derived name when a legacy name is pinned", () => {
    // Given / When
    const cfg = build({ MEMORY_RETRIEVAL_SYMBOL_WEIGHT: "0.01" });

    // Then
    expect(cfg.symbolWeight).toBe(0.5);
  });
});

describe("Field coercion", () => {
  it("should fall back to the declared default when a variable is unset", () => {
    // Given / When / Then
    expect(build().dedupThreshold).toBe(0.82);
  });

  it("should treat a blank variable as unset", () => {
    // Given / When / Then
    expect(build({ MEMORY_RETRIEVAL_MODEL: "   " }).model).toBe("e5-small");
  });

  it("should fall back and record the value when a number cannot be parsed", () => {
    // Given / When
    const cfg = build({ MEMORY_RETRIEVAL_DEDUP_THRESHOLD: "abc" });

    // Then
    expect(cfg.dedupThreshold).toBe(0.82);
    const entry = sectionMeta(cfg).provenance.find((p) => p.path.endsWith("dedupThreshold"));
    expect(entry?.source).toBe("default");
    expect(entry?.ignored).toEqual({ raw: "abc", reason: "could not be parsed" });
  });

  it("should accept zero when the range allows it", () => {
    // Given / When / Then — the `Number(x) || default` idiom this replaces could not express 0.
    expect(build({ MEMORY_RETRIEVAL_DEDUP_THRESHOLD: "0" }).dedupThreshold).toBe(0);
  });

  it("should match an enum member case-insensitively", () => {
    // Given / When / Then
    expect(build({ MEMORY_RETRIEVAL_POSTURE: "SUGGEST" }).posture).toBe(Posture.SUGGEST);
  });

  it("should fall back when an enum member is misspelled", () => {
    // Given / When / Then
    expect(build({ MEMORY_RETRIEVAL_POSTURE: "atuo" }).posture).toBe(Posture.AUTO);
  });
});

describe("Field validation", () => {
  it("should throw an actionable error when a value is out of range", () => {
    // Given / When / Then
    expect(() => build({ MEMORY_RETRIEVAL_DEDUP_THRESHOLD: "1.5" })).toThrow(ConfigError);
    expect(() => build({ MEMORY_RETRIEVAL_DEDUP_THRESHOLD: "1.5" })).toThrow(
      /MEMORY_RETRIEVAL_DEDUP_THRESHOLD .* must be <= 1, got '1.5'/,
    );
  });

  it("should throw when an integer field is given a fraction", () => {
    // Given / When / Then
    expect(() => build({ MEMORY_RETRIEVAL_WORKING_SET_TOKENS: "12.5" })).toThrow(
      /must be an integer/,
    );
  });

  it("should throw when a positive field is given zero", () => {
    // Given / When / Then
    expect(() => build({ MEMORY_SYMBOL_WEIGHT: "0" })).toThrow(ConfigError);
  });
});

describe("Section instances", () => {
  it("should be frozen so config cannot drift at runtime", () => {
    // Given
    const cfg = build();

    // When / Then
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("should serialize to exactly its values, with provenance kept off the instance", () => {
    // Given / When
    const cfg = build({ MEMORY_SYMBOL_WEIGHT: "0.25" });

    // Then
    expect(JSON.parse(JSON.stringify(cfg))).toEqual({
      symbolWeight: 0.25,
      dedupThreshold: 0.82,
      workingSetTokens: 1500,
      model: "e5-small",
      command: null,
      posture: Posture.AUTO,
    });
  });

  it("should record whether each field came from the environment or a default", () => {
    // Given / When
    const cfg = build({ MEMORY_SYMBOL_WEIGHT: "0.25" });
    const { provenance } = sectionMeta(cfg);

    // Then
    expect(provenance.find((p) => p.path === "retrieval.symbolWeight")?.source).toBe("env");
    expect(provenance.find((p) => p.path === "retrieval.model")?.source).toBe("default");
  });
});

describe("ConfigRegistry", () => {
  it("should aggregate every registered section and surface ignored variables", () => {
    // Given
    const scope = container.createChildContainer();

    @configSection()
    class ScopedConfig extends SectionOf("scoped", {
      weight: num(1).positive(),
    }) {}

    scope.register(CONFIG_SOURCE_TOKEN, {
      useValue: new StaticConfigSource({ MEMORY_SCOPED_WEIGHT: "nope" }),
    });

    // When
    const registry = scope.resolve(ConfigRegistry);
    const effective = registry.effective();

    // Then
    expect(effective.values.scoped).toEqual({ weight: 1 });
    expect(registry.ignored().map((entry) => entry.envName)).toContain("MEMORY_SCOPED_WEIGHT");
    expect(scope.resolve(ScopedConfig).weight).toBe(1);
  });
});
