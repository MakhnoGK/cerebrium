import type { InjectionToken } from "tsyringe";

// Where raw config values come from. The env implementation lives in infrastructure;
// tests pass a plain object, so nothing in the config layer ever touches process.env.
export interface ConfigSource {
  // Raw value for a config path, or undefined when unset. `envName` is the resolved
  // variable name — the source decides whether it consults it.
  read(path: string, envName: string): string | undefined;
}

export const CONFIG_SOURCE_TOKEN: InjectionToken<ConfigSource> = Symbol("ConfigSource");

// Why a value ended up where it did. Collected per section, aggregated by ConfigRegistry,
// and surfaced by `stats`/`status` — a silent fallback is what made config drift
// invisible across processes, so every fallback is recorded rather than swallowed.
export interface FieldProvenance {
  path: string;
  envName: string;
  source: "default" | "env";
  ignored?: { raw: string; reason: string };
}
