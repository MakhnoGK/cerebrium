import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A bin's location relative to this module depends on the build layout: bundled (tsup) the
// bins are flat siblings in dist/ ("./daemon.js"); running from source (tsx) each one sits in
// its app's src/. Resolve by probing rather than assuming.
const SOURCE_BIN_DIRS = ["../../../../apps/host/src", "../../../../apps/plugin/src"];

function resolveBinPath(name: string): string {
  const candidates = [`./${name}.js`, ...SOURCE_BIN_DIRS.map((dir) => `${dir}/${name}.ts`)];

  for (const rel of candidates) {
    const p = fileURLToPath(new URL(rel, import.meta.url));

    if (existsSync(p)) {
      return p;
    }
  }

  return fileURLToPath(new URL(`./${name}.js`, import.meta.url));
}

export function resolveDaemonPath(): string {
  return resolveBinPath("daemon");
}

export function resolveRunnerPath(): string {
  return resolveBinPath("runner");
}

// The MCP server entry point, resolved the same way the daemon's is: bundled they are flat
// siblings in dist/, from source each is in its app's src/. The runner hands this path to the
// agent it spawns, so the agent talks to the same build the runner does.
export function resolveServerPath(): string {
  return resolveBinPath("server");
}
