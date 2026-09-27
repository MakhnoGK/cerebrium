import { homedir } from "node:os";
import { join } from "node:path";

// The install layout, derived from one place. `CEREBRIUM_HOME` is the Tier-1 bootstrap
// variable: it is read directly, before any ConfigSource exists, because the config file
// itself lives under it. Every other path here hangs off that single answer, so a process
// cannot resolve the database from one root and the model cache from another.
//
// The environment is a parameter, not an ambient read, so this is testable without
// mutating process.env.
export function cerebriumHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CEREBRIUM_HOME?.trim();

  return configured?.length ? configured : join(homedir(), ".cerebrium");
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cerebriumHome(env), "config.json");
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cerebriumHome(env), "memory.db");
}

export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cerebriumHome(env), "models");
}
