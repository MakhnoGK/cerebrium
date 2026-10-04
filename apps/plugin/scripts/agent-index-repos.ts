import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { readIndexConfig, writeIndexConfig } from "@plugin/src/code/index-config";
import { installHooks } from "@plugin/src/code/index-opt-in";

export interface IndexReposInput {
  home: string;
  repoRoot: string;
  nodePath: string;
  kernelUrl: string;
  tokenFile: string;
  repos: string[];
}

export interface IndexRepoOutcome {
  repo: string;
  ok: boolean;
  detail: string;
}

export function indexBundle(repoRoot: string): string {
  return join(repoRoot, "apps", "plugin", "dist", "index.js");
}

export function applyIndexRepos(input: IndexReposInput): IndexRepoOutcome[] {
  const cerebriumHome = join(input.home, ".cerebrium");
  const bundle = indexBundle(input.repoRoot);
  const prior = readIndexConfig(cerebriumHome);
  const repos = new Set(prior?.repos ?? []);
  const outcomes: IndexRepoOutcome[] = [];

  for (const raw of input.repos) {
    const repo = resolve(raw);

    try {
      const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim();
      const hooks = installHooks(top, input.nodePath, bundle);

      repos.add(top);
      outcomes.push({ repo: top, ok: true, detail: `hooks: ${hooks.join(", ")}` });
    } catch (err) {
      outcomes.push({ repo, ok: false, detail: (err as Error).message.split("\n")[0] ?? "" });
    }
  }

  writeIndexConfig(cerebriumHome, {
    kernel: input.kernelUrl,
    token_file: input.tokenFile,
    bundle,
    repos: [...repos].sort(),
  });

  return outcomes;
}

export function planIndexRepos(input: IndexReposInput): IndexRepoOutcome[] {
  const listed = new Set(readIndexConfig(join(input.home, ".cerebrium"))?.repos ?? []);

  return input.repos.map((raw) => {
    const repo = resolve(raw);

    return {
      repo,
      ok: listed.has(repo),
      detail: listed.has(repo) ? "indexed on the host" : "not opted in yet (--apply)",
    };
  });
}
