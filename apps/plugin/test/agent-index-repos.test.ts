import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyIndexRepos } from "@plugin/scripts/agent-index-repos";
import { readIndexConfig } from "@plugin/src/code/index-config";
import { INDEX_HOOKS, optInCheckout } from "@plugin/src/code/index-opt-in";

let dir: string;
let repo: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cb-index-repos-")));
  repo = join(dir, "widgets");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const input = () => ({
  home: join(dir, "home"),
  repoRoot: join(dir, "cerebrium"),
  nodePath: process.execPath,
  kernelUrl: "tcp://100.0.0.1:7433",
  tokenFile: join(dir, "token"),
  repos: [repo],
});

describe("Opting a checkout into the host's code index", () => {
  it("should list the repo and install every re-index hook", () => {
    // Given / When
    const [outcome] = applyIndexRepos(input());
    const config = readIndexConfig(join(dir, "home", ".cerebrium"));

    // Then
    expect(outcome?.ok).toBe(true);
    expect(config).toMatchObject({
      kernel: "tcp://100.0.0.1:7433",
      bundle: join(dir, "cerebrium", "apps", "plugin", "dist", "index.js"),
    });
    expect(config?.repos).toHaveLength(1);
    for (const name of INDEX_HOOKS) {
      expect(readFileSync(join(repo, ".git", "hooks", name), "utf8")).toContain("--detach --quiet");
    }
  });

  it("should keep an existing hook and still run it first, with its exit status", () => {
    // Given
    const hook = join(repo, ".git", "hooks", "post-commit");
    const marker = join(dir, "ran");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 3\n`);
    chmodSync(hook, 0o755);

    // When
    applyIndexRepos(input());
    const run = spawnSync(hook, [], { cwd: repo });

    // Then
    expect(readFileSync(`${hook}.cerebrium-prev`, "utf8")).toContain("exit 3");
    expect(run.status).toBe(3);
    expect(() => readFileSync(marker)).not.toThrow();
  });

  it("should be safe to apply twice", () => {
    // Given
    applyIndexRepos(input());

    // When
    const [again] = applyIndexRepos(input());

    // Then
    expect(again?.ok).toBe(true);
    expect(readIndexConfig(join(dir, "home", ".cerebrium"))?.repos).toHaveLength(1);
    expect(() => readFileSync(join(repo, ".git", "hooks", "post-commit.cerebrium-prev"))).toThrow();
  });
});

describe("Opting a checkout in from code_index", () => {
  const home = () => join(dir, "home", ".cerebrium");
  const other = () => join(dir, "other");

  beforeEach(() => {
    mkdirSync(other());
    execFileSync("git", ["-C", other(), "init", "-q"]);
    applyIndexRepos({ ...input(), repos: [other()] });
  });

  it("should list an unlisted checkout and install its hooks", () => {
    // Given / When
    const detail = optInCheckout(home(), repo, process.execPath);

    // Then
    expect(detail).toContain(repo);
    expect(readIndexConfig(home())?.repos).toEqual([other(), repo].sort());
    for (const name of INDEX_HOOKS) {
      expect(readFileSync(join(repo, ".git", "hooks", name), "utf8")).toContain("--detach --quiet");
    }
  });

  it("should change nothing for a checkout that is already listed", () => {
    // Given / When
    const detail = optInCheckout(home(), other(), process.execPath);

    // Then
    expect(detail).toBeNull();
    expect(readIndexConfig(home())?.repos).toEqual([other()]);
  });

  it("should change nothing on a machine never set up for the host index", () => {
    // Given / When
    const detail = optInCheckout(join(dir, "elsewhere"), repo, process.execPath);

    // Then
    expect(detail).toBeNull();
    expect(() => readFileSync(join(repo, ".git", "hooks", "post-commit"))).toThrow();
  });
});
