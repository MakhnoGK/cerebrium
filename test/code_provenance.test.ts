import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { container } from "tsyringe";
import { setup } from "@test/helpers";
import { indexRepo } from "@/code/indexer";
import { readGitProvenance } from "@/code/git";
import { CodeIndexTool } from "../src/tools/code-index";

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

describe("Repo provenance store", () => {
  it("should round-trip and upsert one row per repo when provenance is set twice", () => {
    // Given
    const { code, clock } = setup();

    // When
    code.setRepoProvenance("api", "/repos/api", "main", "abc1234", false, clock.t);

    // Then
    expect(code.repoProvenance("api")).toMatchObject({
      repo: "api",
      root: "/repos/api",
      branch: "main",
      commit: "abc1234",
      dirty: false,
    });

    // When — upsert.
    code.setRepoProvenance("api", "/repos/api", "feature/x", "def5678", true, clock.t);

    // Then
    expect(code.allRepoProvenance()).toHaveLength(1);
    expect(code.repoProvenance("api")).toMatchObject({
      branch: "feature/x",
      commit: "def5678",
      dirty: true,
    });
  });

  it("should expose remembered roots as index targets and exclude rootless repos", () => {
    // Given
    const { code, clock } = setup();

    // When
    code.setRepoProvenance("api", "/repos/api", null, null, false, clock.t);
    code.setRepoProvenance("web", null, null, null, false, clock.t); // no root -> excluded

    // Then
    expect(code.storedRepoRoots()).toEqual([{ name: "api", root: "/repos/api" }]);
  });
});

describe("Indexer records provenance", () => {
  it("should store nulls for a non-git root and surface it in stats", async () => {
    // Given
    const { code, queue, stats, clock } = setup();
    const root = tmp("mk-index-prov-");
    writeFileSync(join(root, "x.ts"), "export function hello() { return 1; }\n");

    // When
    const s = await indexRepo(
      code,
      queue,
      { name: "proj", root },
      { session_id: "s", now: () => clock.t },
    );

    // Then
    expect(s).toMatchObject({ branch: null, commit: null, dirty: false });
    expect(code.repoProvenance("proj")).toMatchObject({ repo: "proj", branch: null });
    expect(stats.techStats(clock.t).code_repos).toHaveLength(1);
  });

  it("should tolerate a DB predating the code_repos migration when computing techStats", () => {
    // Given
    const { stats, db, clock } = setup();
    db.exec("DROP TABLE code_repos"); // simulate a pre-004 database

    // When / Then
    expect(() => stats.techStats(clock.t)).not.toThrow();
    expect(stats.techStats(clock.t).code_repos).toEqual([]);
  });

  it("should tolerate a code_repos table predating the root column", () => {
    // Given
    const { code, db } = setup();
    db.exec(
      `DROP TABLE code_repos;
       CREATE TABLE code_repos (repo TEXT PRIMARY KEY, branch TEXT, commit_sha TEXT, dirty INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL);
       INSERT INTO code_repos (repo, branch, commit_sha, dirty, indexed_at) VALUES ('api','main','abc',0,'t');`,
    );

    // When / Then
    expect(() => code.allRepoProvenance()).not.toThrow();
    expect(code.repoProvenance("api")).toMatchObject({ repo: "api", root: null, branch: "main" });
  });
});

describe("code_index remembers roots for name-based re-index", () => {
  const saved = process.env.MEMORY_CODE_ROOTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMORY_CODE_ROOTS;
    else process.env.MEMORY_CODE_ROOTS = saved;
  });

  it("should re-index by name from a stored root when MEMORY_CODE_ROOTS lacks it", async () => {
    // Given
    delete process.env.MEMORY_CODE_ROOTS; // nothing configured
    setup();
    const codeIndex = container.resolve(CodeIndexTool);
    const root = tmp("mk-remember-");
    writeFileSync(join(root, "y.ts"), "export const answer = 42;\n");

    // When — first index by explicit path should remember the root.
    const first = (await codeIndex.invoke({ session_id: "s", path: root })) as Record<string, any>;
    const name = first.repo as string;

    // Then — re-index by NAME alone, still with no MEMORY_CODE_ROOTS — resolves from the store.
    const again = (await codeIndex.invoke({ session_id: "s", repo: name })) as Record<string, any>;
    expect(again.repo).toBe(name);
    expect(again.files_scanned).toBe(1);
    expect(again.files_skipped).toBe(1); // hash-gated, unchanged
  });

  it("should throw clearly for an unknown, never-indexed repo name", async () => {
    // Given
    delete process.env.MEMORY_CODE_ROOTS;
    setup();
    const codeIndex = container.resolve(CodeIndexTool);

    // When / Then
    await expect(codeIndex.invoke({ session_id: "s", repo: "ghost" })).rejects.toThrow(
      /has not been indexed/,
    );
  });
});
