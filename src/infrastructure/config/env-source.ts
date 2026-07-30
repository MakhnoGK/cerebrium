import { injectable } from "tsyringe";
import type { ConfigSource } from "@/domain/ports/config";

// Reads config from the environment. Takes the environment as a constructor argument so
// the whole config layer is testable without mutating process.env.
//
// Precedence today is defaults <- env. A config.json tier slots in ahead of this one
// (defaults <- file <- env) behind the same ConfigSource interface, with no changes at
// any call site.
@injectable()
export class EnvConfigSource implements ConfigSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  read(_path: string, envName: string): string | undefined {
    return this.env[envName];
  }
}

// A source with no values at all: every section resolves to its declared fallbacks.
export class DefaultConfigSource implements ConfigSource {
  read(): string | undefined {
    return undefined;
  }
}

// A source backed by a plain object keyed by env-var name — the test seam.
export class StaticConfigSource implements ConfigSource {
  constructor(private readonly values: Record<string, string | undefined>) {}

  read(_path: string, envName: string): string | undefined {
    return this.values[envName];
  }
}
