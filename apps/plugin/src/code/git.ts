import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { displayNameOf, isIndexablePath, normalizeRemote } from "@cerebrium/contracts/code";

const run = promisify(execFile);

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    return stdout;
  } catch {
    return null;
  }
}

const sshHosts = new Map<string, Promise<string>>();

// An SSH alias (`github-toonspace`) stands for a real host; `ssh -G` resolves it the way git
// would when it connects.
function sshHost(alias: string): Promise<string> {
  let resolved = sshHosts.get(alias);

  if (!resolved) {
    resolved = run("ssh", ["-G", alias], { encoding: "utf8", timeout: 3_000 })
      .then(({ stdout }) => /^hostname\s+(\S+)$/m.exec(stdout)?.[1] ?? alias)
      .catch(() => alias);
    sshHosts.set(alias, resolved);
  }

  return resolved;
}

export async function remoteKeyOf(url: string): Promise<string | null> {
  const ssh = !/^https?:\/\//i.test(url.trim());
  const probe = normalizeRemote(url);

  if (probe === null) return null;

  if (!ssh) return probe;

  const host = probe.split("/")[0]!;
  const real = await sshHost(host);

  return normalizeRemote(url, () => real);
}

export interface Checkout {
  root: string;
  remote_key: string;
  display_name: string;
  branch: string;
  commit: string | null;
  dirty: boolean;
  default_branch: string | null;
}

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  return (await git(dir, ["rev-parse", "--show-toplevel"]))?.trim() || null;
}

async function remoteUrl(root: string): Promise<string | null> {
  const origin = (await git(root, ["remote", "get-url", "origin"]))?.trim();

  if (origin) return origin;

  const first = (await git(root, ["remote"]))
    ?.split("\n")
    .find((r) => r.trim().length)
    ?.trim();

  return first ? ((await git(root, ["remote", "get-url", first]))?.trim() ?? null) : null;
}

// A repo made with `git init` and pushed, rather than cloned, has no origin/HEAD.
async function defaultBranchOf(root: string): Promise<string | null> {
  const head = (
    await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
  )?.trim();

  if (head) return head.replace(/^[^/]+\//, "");

  for (const name of ["main", "master"]) {
    if ((await git(root, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${name}`])) !== null)
      return name;
  }

  return null;
}

// The repo identity and branch of a working directory, or why there is none.
export async function readCheckout(dir: string, withStatus = true): Promise<Checkout> {
  const root = await repoRoot(dir);

  if (root === null) throw new CheckoutError(`${dir} is not inside a git checkout`);

  const url = await remoteUrl(root);

  if (!url)
    throw new CheckoutError(`${root} has no git remote, so it has no identity to index under`);

  const remote_key = await remoteKeyOf(url);

  if (remote_key === null)
    throw new CheckoutError(`cannot read a repo identity from remote ${url}`);

  const branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim();

  if (!branch)
    throw new CheckoutError(`${root} is on a detached HEAD; check out a branch to index it`);

  const commit = (await git(root, ["rev-parse", "HEAD"]))?.trim() || null;
  const status = withStatus ? await git(root, ["status", "--porcelain"]) : "";

  return {
    root,
    remote_key,
    display_name: displayNameOf(remote_key) || basename(root),
    branch,
    commit,
    dirty: (status ?? "").trim().length > 0,
    default_branch: await defaultBranchOf(root),
  };
}

// Tracked files plus untracked ones git does not ignore — the working tree as the author
// sees it — filtered to what the index parses.
export async function listIndexable(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);

  if (out === null) throw new CheckoutError(`git ls-files failed in ${root}`);

  return [...new Set(out.split("\0").filter((p) => p.length && isIndexablePath(p)))].sort();
}

// Every branch the repo still has, local or on a remote, by its short name.
export async function listBranches(root: string): Promise<string[]> {
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const names = new Set<string>();

  for (const ref of (out ?? "").split("\n")) {
    if (ref.startsWith("refs/heads/")) names.add(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length).replace(/^[^/]+\//, "");

      if (name.length && name !== "HEAD") names.add(name);
    }
  }

  return [...names].sort();
}
