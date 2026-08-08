import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

interface RuntimeProcess {
  execPath: string;
  version: string;
}

type Probe = (file: string, args: string[], options: { cwd: string; stdio: "pipe" }) => unknown;

/** Resolve the exact runtime selected by this repo's simple numeric `.nvmrc`. */
export function resolveNodeRuntime(repoRoot: string, current: RuntimeProcess = process): string {
  const nvmrcPath = join(repoRoot, ".nvmrc");
  let requested: string;
  try {
    requested = readFileSync(nvmrcPath, "utf8").trim().replace(/^v/, "");
  } catch {
    throw new Error(`${nvmrcPath} is missing — run \`nvm use && npm install\` from the repository`);
  }

  if (!/^\d+(?:\.\d+){0,2}$/.test(requested)) {
    throw new Error(
      `${nvmrcPath} must contain a numeric Node version; run \`nvm use && npm install\``,
    );
  }

  const actual = current.version.replace(/^v/, "");
  const requestedParts = requested.split(".");
  const actualParts = actual.split(".");
  const matches = requestedParts.every((part, index) => actualParts[index] === part);
  if (!matches) {
    throw new Error(
      `.nvmrc requires Node ${requested}, but setup is running on ${actual}; ` +
        "run `nvm use && npm install` before agent setup",
    );
  }

  return realpathSync(current.execPath);
}

/** Prove the selected runtime can load the installed native SQLite addon before config writes. */
export function assertNativeRuntime(
  repoRoot: string,
  nodePath: string,
  probe: Probe = execFileSync,
): void {
  try {
    probe(
      nodePath,
      [
        "-e",
        "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()",
      ],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } catch {
    throw new Error(
      `Node runtime ${nodePath} cannot load better-sqlite3; run \`nvm use && npm install\` ` +
        "before agent setup",
    );
  }
}
