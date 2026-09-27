import "reflect-metadata";
import { buildContainer } from "@/container";
import { EnvConfigSource, LayeredConfigSource, StaticConfigSource } from "@/infrastructure/config";

// The suite wires itself through the same buildContainer the three hosts use, so a token
// cannot be registered in production and missing here (or the reverse).
//
// The pins sit AHEAD of the environment: no model download, no API key, and above all
// never the real database — an ambient MEMORY_DB_PATH must not point the suite at
// ~/.cerebrium/memory.db. Everything else still reads the environment live, which the
// tests that set MEMORY_* inside a test body rely on.
buildContainer({
  role: "server",
  source: new LayeredConfigSource(
    new StaticConfigSource({
      MEMORY_DB_PATH: ":memory:",
      MEMORY_EMBED_PROVIDER: "local-null",
      MEMORY_CONSOLIDATE: "manual",
    }),
    new EnvConfigSource(),
  ),
});
