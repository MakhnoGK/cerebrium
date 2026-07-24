import { execFileSync } from "node:child_process";

export interface GitProvenance {
  branch: string | null; // 'main', or null when not a git repo / detached with no name
  commit: string | null; // short sha, or null
  dirty: boolean; // uncommitted changes in the working tree
}

const NONE: GitProvenance = { branch: null, commit: null, dirty: false };

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

// Best-effort provenance of the working tree being indexed. Purely informational
// (which branch/commit the index reflects); never a query key. Any failure — not a
// git repo, git absent, detached HEAD — degrades to nulls rather than throwing.
export function readGitProvenance(root: string): GitProvenance {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return NONE;
  const rawBranch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = rawBranch && rawBranch !== "HEAD" ? rawBranch : null; // 'HEAD' = detached
  return {
    branch,
    commit: git(root, ["rev-parse", "--short", "HEAD"]),
    dirty: (git(root, ["status", "--porcelain"]) ?? "").length > 0,
  };
}
