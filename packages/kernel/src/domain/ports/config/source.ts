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

export type ConfigFileState = "loaded" | "absent" | "unreadable";

// The file tier's own health, which no per-field provenance can express: a corrupt file
// makes every field read as env-or-default, and without this the reason is invisible.
export interface ConfigFileReport {
  path: string;
  state: ConfigFileState;
  // Set only when `state` is "unreadable": what went wrong, in one line.
  problem?: string;
  // Scalar leaves the file contributes, so an empty file is visible as one.
  keys: number;
}

// Null when a caller pinned its own ConfigSource (tests, eval scripts): no file was
// consulted, which is different from having looked and found nothing.
export const CONFIG_FILE_TOKEN: InjectionToken<ConfigFileReport | null> =
  Symbol("ConfigFileReport");
