import type { InjectionToken } from "tsyringe";

// Which tier answered a lookup. Ordering is the caller's business (see
// LayeredConfigSource); a source only reports which one it is.
export type ConfigOrigin = "env" | "file";

export interface ConfigValue {
  raw: string;
  origin: ConfigOrigin;
}

// Where raw config values come from. The env and file implementations live in
// infrastructure; tests pass a plain object, so nothing in the config layer ever touches
// process.env. A value arrives with its origin attached rather than being looked up
// separately, so provenance cannot disagree with the value it describes.
export interface ConfigSource {
  // Raw value for a config path, or undefined when unset. `path` is the dotted config
  // path and `envName` the resolved variable name; a source consults whichever it keys on.
  read(path: string, envName: string): ConfigValue | undefined;
}

export const CONFIG_SOURCE_TOKEN: InjectionToken<ConfigSource> = Symbol("ConfigSource");

// Why a value ended up where it did. Collected per section, aggregated by ConfigRegistry,
// and surfaced by `stats`/`status` — a silent fallback is what made config drift
// invisible across processes, so every fallback is recorded rather than swallowed.
export interface FieldProvenance {
  path: string;
  envName: string;
  source: "default" | ConfigOrigin;
  ignored?: { raw: string; reason: string };
}
