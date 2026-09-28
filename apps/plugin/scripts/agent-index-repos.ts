import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readIndexConfig, writeIndexConfig } from "@plugin/src/code/index-config";

// Opting checkouts into the host's per-branch index: they are listed where the session-start
// hook and the index CLI look, and git hooks re-index them after every commit, checkout,
// merge and rewrite. Hooks are written per repo, never through core.hooksPath.

export const INDEX_HOOKS = ["post-commit", "post-checkout", "post-merge", "post-rewrite"] as const;

const MARKER = "# cerebrium:index";

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

function hooksDir(repo: string): string {
  const common = execFileSync(
    "git",
    ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      encoding: "utf8",
    },
  ).trim();

  return join(common, "hooks");
}

export function hookScript(name: string, nodePath: string, bundle: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  return [
    "#!/bin/sh",
    `${MARKER} — written by agent:setup --index-repo`,
    `prev="$(dirname "$0")/${name}.cerebrium-prev"`,
    "status=0",
    'if [ -x "$prev" ]; then "$prev" "$@"; status=$?; fi',
    `${q(nodePath)} ${q(bundle)} "$(git rev-parse --show-toplevel)" --detach --quiet --min-interval 5 >/dev/null 2>&1 || true`,
    'exit "$status"',
    "",
  ].join("\n");
}

export function installHooks(repo: string, nodePath: string, bundle: string): string[] {
  const dir = hooksDir(repo);
  const done: string[] = [];

  mkdirSync(dir, { recursive: true });

  for (const name of INDEX_HOOKS) {
    const path = join(dir, name);

    if (existsSync(path) && !readFileSync(path, "utf8").includes(MARKER)) {
      const prev = `${path}.cerebrium-prev`;

      if (existsSync(prev)) throw new Error(`${prev} already exists; resolve it by hand`);

      renameSync(path, prev);
      done.push(`${name} (kept the existing hook as ${name}.cerebrium-prev)`);
    } else {
      done.push(name);
    }

    writeFileSync(path, hookScript(name, nodePath, bundle));
    chmodSync(path, 0o755);
  }

  return done;
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
