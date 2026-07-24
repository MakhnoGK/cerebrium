import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "./helpers";
import { indexRepo } from "@/code/indexer";
import { readGitProvenance } from "@/code/git";
import * as code_index from "@/tools/code_index";

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
  it("returns nulls for a non-git directory", () => {
    expect(readGitProvenance(tmp("mk-nogit-"))).toEqual({
      branch: null,
      commit: null,
      dirty: false,
    });
  });

  it("reports branch, commit, and dirty state for a real repo", () => {
    const root = tmp("mk-git-");
    g(root, "init", "-q", "-b", "trunk");
    g(root, "config", "user.email", "t@t.t");
    g(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "one");
    g(root, "add", ".");
    g(root, "commit", "-qm", "first");

    const clean = readGitProvenance(root);
    expect(clean.branch).toBe("trunk");
    expect(clean.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(clean.dirty).toBe(false);

    writeFileSync(join(root, "a.txt"), "changed");
    expect(readGitProvenance(root).dirty).toBe(true);
  });
});

describe("repo provenance store", () => {
  it("round-trips and upserts one row per repo", () => {
    const { repo, clock } = makeCtx();
    repo.setRepoProvenance("api", "/repos/api", "main", "abc1234", false, clock.t);
    expect(repo.repoProvenance("api")).toMatchObject({
      repo: "api",
      root: "/repos/api",
      branch: "main",
      commit: "abc1234",
      dirty: false,
    });

    repo.setRepoProvenance("api", "/repos/api", "feature/x", "def5678", true, clock.t); // upsert
    expect(repo.allRepoProvenance()).toHaveLength(1);
    expect(repo.repoProvenance("api")).toMatchObject({
      branch: "feature/x",
      commit: "def5678",
      dirty: true,
    });
  });

  it("storedRepoRoots exposes remembered roots as index targets", () => {
    const { repo, clock } = makeCtx();
    repo.setRepoProvenance("api", "/repos/api", null, null, false, clock.t);
    repo.setRepoProvenance("web", null, null, null, false, clock.t); // no root → excluded
    expect(repo.storedRepoRoots()).toEqual([{ name: "api", root: "/repos/api" }]);
  });
});

describe("indexer records provenance", () => {
  it("stores nulls for a non-git root and surfaces it in stats", async () => {
    const { repo, clock } = makeCtx();
    const root = tmp("mk-index-prov-");
    writeFileSync(join(root, "x.ts"), "export function hello() { return 1; }\n");

    const stats = await indexRepo(
      repo,
      { name: "proj", root },
      { session_id: "s", now: () => clock.t },
    );
    expect(stats).toMatchObject({ branch: null, commit: null, dirty: false });
    expect(repo.repoProvenance("proj")).toMatchObject({ repo: "proj", branch: null });
    expect(repo.techStats(clock.t).code_repos).toHaveLength(1);
  });

  it("techStats tolerates a DB predating the code_repos migration", () => {
    const { repo, db, clock } = makeCtx();
    db.exec("DROP TABLE code_repos"); // simulate a pre-004 database
    expect(() => repo.techStats(clock.t)).not.toThrow();
    expect(repo.techStats(clock.t).code_repos).toEqual([]);
  });

  it("tolerates a code_repos table predating the root column (004 without 005)", () => {
    const { repo, db } = makeCtx();
    db.exec(
      `DROP TABLE code_repos;
       CREATE TABLE code_repos (repo TEXT PRIMARY KEY, branch TEXT, commit_sha TEXT, dirty INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL);
       INSERT INTO code_repos (repo, branch, commit_sha, dirty, indexed_at) VALUES ('api','main','abc',0,'t');`,
    );
    expect(() => repo.allRepoProvenance()).not.toThrow();
    expect(repo.repoProvenance("api")).toMatchObject({ repo: "api", root: null, branch: "main" });
  });
});

describe("code_index remembers roots for name-based re-index", () => {
  const saved = process.env.MEMORY_CODE_ROOTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMORY_CODE_ROOTS;
    else process.env.MEMORY_CODE_ROOTS = saved;
  });

  it("re-indexes by name from a stored root when MEMORY_CODE_ROOTS lacks it", async () => {
    delete process.env.MEMORY_CODE_ROOTS; // nothing configured
    const { ctx } = makeCtx();
    const root = tmp("mk-remember-");
    writeFileSync(join(root, "y.ts"), "export const answer = 42;\n");

    // First index by explicit path — should remember the root.
    const first = (await code_index.handler(ctx, { session_id: "s", path: root })) as Record<
      string,
      any
    >;
    const name = first.repo as string;

    // Now re-index by NAME alone, still with no MEMORY_CODE_ROOTS — resolves from the store.
    const again = (await code_index.handler(ctx, { session_id: "s", repo: name })) as Record<
      string,
      any
    >;
    expect(again.repo).toBe(name);
    expect(again.files_scanned).toBe(1);
    expect(again.files_skipped).toBe(1); // hash-gated, unchanged
  });

  it("errors clearly for an unknown, never-indexed repo name", async () => {
    delete process.env.MEMORY_CODE_ROOTS;
    const { ctx } = makeCtx();
    await expect(code_index.handler(ctx, { session_id: "s", repo: "ghost" })).rejects.toThrow(
      /has not been indexed/,
    );
  });
});
