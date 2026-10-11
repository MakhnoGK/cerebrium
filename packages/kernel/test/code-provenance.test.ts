import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitProvenance } from "@/code/git";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const g = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });

describe("readGitProvenance", () => {
  it("should return nulls when the directory is not a git repo", () => {
    // Given / When / Then
    expect(readGitProvenance(tmp("mk-nogit-"))).toEqual({
      branch: null,
      commit: null,
      dirty: false,
    });
  });

  it("should report branch, commit, and dirty state when the directory is a real repo", () => {
    // Given
    const root = tmp("mk-git-");
    g(root, "init", "-q", "-b", "trunk");
    g(root, "config", "user.email", "t@t.t");
    g(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one");
    g(root, "add", ".");
    g(root, "commit", "-qm", "first");

    // When / Then
    const clean = readGitProvenance(root);
    expect(clean.branch).toBe("trunk");
    expect(clean.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(clean.dirty).toBe(false);

    // When / Then — an uncommitted edit flips dirty.
    writeFileSync(join(root, "a.txt"), "changed");
    expect(readGitProvenance(root).dirty).toBe(true);
  });
});
