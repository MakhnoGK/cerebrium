import { injectable } from "tsyringe";
import type { ConfigSource, ConfigValue } from "@/domain/ports/config";

// Reads config from the environment. Takes the environment as a constructor argument so
// the whole config layer is testable without mutating process.env.
//
// Precedence is defaults <- file <- env: FileConfigSource sits behind this one inside a
// LayeredConfigSource, so an env var stays the documented override.
@injectable()
export class EnvConfigSource implements ConfigSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  read(_path: string, envName: string): ConfigValue | undefined {
    const raw = this.env[envName];

    return raw === undefined ? undefined : { raw, origin: "env" };
  }
}

// A source with no values at all: every section resolves to its declared fallbacks.
export class DefaultConfigSource implements ConfigSource {
  read(): ConfigValue | undefined {
    return undefined;
  }
}

// A source backed by a plain object keyed by env-var name — the test seam. It stands in
// for the environment, so that is the origin it reports.
export class StaticConfigSource implements ConfigSource {
  constructor(private readonly values: Record<string, string | undefined>) {}

  read(_path: string, envName: string): ConfigValue | undefined {
    const raw = this.values[envName];

    return raw === undefined ? undefined : { raw, origin: "env" };
  }
}

// Consults its sources in order; the first one with a value wins. Ordering is the
// caller's precedence statement — the test suite puts its pins ahead of the environment
// so an ambient variable cannot drag the suite online.
export class LayeredConfigSource implements ConfigSource {
  private readonly sources: ConfigSource[];

  constructor(...sources: ConfigSource[]) {
    this.sources = sources;
  }

  read(path: string, envName: string): ConfigValue | undefined {
    for (const source of this.sources) {
      const value = source.read(path, envName);

      if (value !== undefined) {
        return value;
      }
    }

    return undefined;
  }
}
