import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIndexConfig, writeIndexConfig } from "@plugin/src/code/index-config";

// Opting a checkout into the host's per-branch index: it is listed where the session-start
// hook, the index CLI and the code-nav mod look, and git hooks re-index it after every commit,
// checkout, merge and rewrite. Hooks are written per repo, never through core.hooksPath.

export const INDEX_HOOKS = ["post-commit", "post-checkout", "post-merge", "post-rewrite"] as const;

const MARKER = "# cerebrium:index";

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

function hookScript(name: string, nodePath: string, bundle: string): string {
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

// What a `code_index` call changed in the opt-in, or null when the checkout is already listed
// or this machine was never set up for the host index.
export function optInCheckout(home: string, root: string, nodePath: string): string | null {
  const config = readIndexConfig(home);

  if (!config?.bundle || config.repos.includes(root)) return null;

  writeIndexConfig(home, { ...config, repos: [...config.repos, root].sort() });

  const hooks = installHooks(root, nodePath, config.bundle);

  return `${root} is now opted in: listed for the code-nav mod, re-indexed by git hooks ${hooks.join(", ")}.`;
}
