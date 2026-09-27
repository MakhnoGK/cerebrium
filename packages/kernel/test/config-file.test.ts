import { describe, expect, it } from "vitest";
import { num, sectionMeta, SectionOf, str } from "@/domain/ports/config";
import {
  EnvConfigSource,
  FileConfigSource,
  LayeredConfigSource,
  StaticConfigSource,
} from "@/infrastructure/config";

const CONFIG = JSON.stringify({
  database: { path: "/from/file/memory.db" },
  retrieval: { foldSim: 0.5, roots: "a=/one", frontier: { a: 1 } },
});

function fileSource(text: string | Error): FileConfigSource {
  return new FileConfigSource("/opt/brain/config.json", () => {
    if (text instanceof Error) throw text;
    return text;
  });
}

class RetrievalConfig extends SectionOf("retrieval", {
  foldSim: num(0.93),
  roots: str("none"),
  frontier: num(500),
}) {}

describe("FileConfigSource", () => {
  it("should read a scalar by its dotted config path", () => {
    // Given / When / Then
    expect(fileSource(CONFIG).read("database.path", "MEMORY_DB_PATH")).toEqual({
      raw: "/from/file/memory.db",
      origin: "file",
    });
  });

  it("should coerce a non-string scalar so a number in the file behaves like the env var", () => {
    // Given / When / Then
    expect(fileSource(CONFIG).read("retrieval.foldSim", "MEMORY_FOLD_SIM")?.raw).toBe("0.5");
  });

  it("should report nothing for a path the file does not carry", () => {
    // Given / When / Then
    expect(fileSource(CONFIG).read("retrieval.mmrLambda", "MEMORY_MMR_LAMBDA")).toBeUndefined();
  });

  it("should treat a missing file as absent rather than as an error", () => {
    // Given
    const source = fileSource(new Error("ENOENT"));

    // When / Then
    expect(source.read("database.path", "MEMORY_DB_PATH")).toBeUndefined();
    expect(source.report()).toEqual({
      path: "/opt/brain/config.json",
      state: "absent",
      keys: 0,
    });
  });

  it("should degrade to no values and name the problem when the file is corrupt", () => {
    // Given
    const source = fileSource('{"database": {,}}');

    // When / Then
    expect(source.read("database.path", "MEMORY_DB_PATH")).toBeUndefined();
    const report = source.report();
    expect(report.state).toBe("unreadable");
    expect(report.problem).toBeTruthy();
  });

  it("should reject a top-level array, which cannot address a config path", () => {
    // Given / When / Then
    expect(fileSource("[1, 2]").report().state).toBe("unreadable");
  });

  it("should count the scalar leaves it contributes", () => {
    // Given / When / Then
    expect(fileSource(CONFIG).report()).toMatchObject({ state: "loaded", keys: 4 });
  });
});

describe("Config tiers", () => {
  it("should let a file value win over the default and an env var win over the file", () => {
    // Given — the precedence buildContainer wires: env ahead of file.
    const layered = new LayeredConfigSource(
      new StaticConfigSource({ MEMORY_RETRIEVAL_FOLD_SIM: "0.1" }),
      fileSource(CONFIG),
    );

    // When
    const fromFile = new RetrievalConfig(new LayeredConfigSource(fileSource(CONFIG)));
    const fromEnv = new RetrievalConfig(layered);

    // Then
    expect(fromFile.foldSim).toBe(0.5);
    expect(fromEnv.foldSim).toBe(0.1);
  });

  it("should record which tier each value came from", () => {
    // Given / When
    const config = new RetrievalConfig(
      new LayeredConfigSource(
        new StaticConfigSource({ MEMORY_RETRIEVAL_ROOTS: "from-env" }),
        fileSource(CONFIG),
      ),
    );
    const byPath = new Map(sectionMeta(config).provenance.map((entry) => [entry.path, entry]));

    // Then
    expect(byPath.get("retrieval.foldSim")?.source).toBe("file");
    expect(byPath.get("retrieval.roots")?.source).toBe("env");
  });

  it("should record a non-scalar leaf as an ignored value rather than swallowing it", () => {
    // Given / When — `retrieval.frontier` is an object in the file, and a numeric field.
    const config = new RetrievalConfig(new LayeredConfigSource(fileSource(CONFIG)));
    const entry = sectionMeta(config).provenance.find((p) => p.path === "retrieval.frontier");

    // Then
    expect(config.frontier).toBe(500);
    expect(entry).toMatchObject({ source: "default", ignored: { raw: '{"a":1}' } });
  });

  it("should not consult the environment for a path the file answers", () => {
    // Given
    const layered = new LayeredConfigSource(new EnvConfigSource({}), fileSource(CONFIG));

    // When / Then
    expect(layered.read("database.path", "MEMORY_DB_PATH")?.origin).toBe("file");
  });
});
