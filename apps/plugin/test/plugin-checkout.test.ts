import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCheckout } from "@plugin/src/code/git";

let dir: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cb-checkout-")));
  repo = join(dir, "widgets");
  mkdirSync(repo);
  git("init", "-q", "-b", "feature");
  git("remote", "add", "origin", "https://github.com/Acme/Widgets.git");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("The default branch of a checkout", () => {
  it("should follow origin/HEAD when the clone has one", async () => {
    // Given
    git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

    // When
    const checkout = await readCheckout(repo);

    // Then
    expect(checkout.default_branch).toBe("trunk");
  });

  it("should fall back to origin/main when the repo was pushed, not cloned", async () => {
    // Given
    git("update-ref", "refs/remotes/origin/main", "HEAD");

    // When
    const checkout = await readCheckout(repo);

    // Then
    expect(checkout).toMatchObject({ branch: "feature", default_branch: "main" });
  });

  it("should fall back to origin/master when there is no origin/main", async () => {
    // Given
    git("update-ref", "refs/remotes/origin/master", "HEAD");

    // When
    const checkout = await readCheckout(repo);

    // Then
    expect(checkout.default_branch).toBe("master");
  });

  it("should not guess from the local branch when the remote has neither", async () => {
    // Given / When
    const checkout = await readCheckout(repo);

    // Then
    expect(checkout.default_branch).toBeNull();
  });
});
