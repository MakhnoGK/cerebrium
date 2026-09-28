import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Which checkouts this machine indexes on its Cerebrium host, and how to reach the host.
// Written by `agent:setup --index-repo`, read by the index CLI and the session-start hook.
export interface IndexConfig {
  kernel: string;
  token_file: string;
  bundle: string;
  repos: string[];
}

export function indexConfigPath(home: string): string {
  return join(home, "plugin-index.json");
}

export function readIndexConfig(home: string): IndexConfig | null {
  const path = indexConfigPath(home);

  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexConfig>;

    if (typeof raw.kernel !== "string" || typeof raw.token_file !== "string") return null;

    return {
      kernel: raw.kernel,
      token_file: raw.token_file,
      bundle: typeof raw.bundle === "string" ? raw.bundle : "",
      repos: Array.isArray(raw.repos) ? raw.repos.filter((r) => typeof r === "string") : [],
    };
  } catch {
    return null;
  }
}

export function writeIndexConfig(home: string, config: IndexConfig): void {
  const path = indexConfigPath(home);
  const tmp = `${path}.tmp`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
