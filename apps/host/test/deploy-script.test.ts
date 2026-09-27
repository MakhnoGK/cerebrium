import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../deploy/deploy.sh");

// Stands in for the docker CLI: a running postgres container, and a pg_dump whose outcome
// FAKE_DUMP decides.
const FAKE_DOCKER = `#!/bin/bash
case "$*" in
  *"ps -q postgres"*) [[ "$FAKE_PG" == "none" ]] || echo cid123 ;;
  inspect*) echo running ;;
  *"pg_dump"*)
    case "$FAKE_DUMP" in
      fail) exit 3 ;;
      empty) ;;
      *) printf 'PGDMP-fake' ;;
    esac ;;
esac
`;

let root: string;

function run(
  body: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("/bin/bash", ["-c", `source "${SCRIPT}"; ${body}`], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      CEREBRIUM_HOST_ROOT: root,
      ...env,
    },
    encoding: "utf8",
  });

  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cb-deploy-"));
  // deploy.sh puts $HOME/.orbstack/bin first on PATH, which is where OrbStack's docker lives.
  mkdirSync(join(root, ".orbstack/bin"), { recursive: true });
  writeFileSync(join(root, ".orbstack/bin/docker"), FAKE_DOCKER);
  chmodSync(join(root, ".orbstack/bin/docker"), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("deploy.sh secrets", () => {
  it("should create the Postgres password once, keep it private, and never print it", () => {
    // Given / When
    const first = run("ensure_secrets");
    const password = readFileSync(join(root, "secrets/pg_password"), "utf8");
    const second = run("ensure_secrets");

    // Then
    expect(first.status).toBe(0);
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(readFileSync(join(root, "secrets/pg_password"), "utf8")).toBe(password);
    expect(readFileSync(join(root, "secrets/pg_url"), "utf8")).toBe(
      `postgres://cerebrium:${password}@postgres:5432/cerebrium`,
    );
    expect(statSync(join(root, "secrets")).mode & 0o777).toBe(0o700);
    expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(password);
  });
});

describe("deploy.sh backup", () => {
  it("should skip the dump when there is no previous release", () => {
    // Given / When
    const res = run('backup ""');

    // Then
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("skipping the dump");
    expect(existsSync(join(root, "backups"))).toBe(false);
  });

  it("should skip the dump when the previous release runs no Postgres", () => {
    // Given / When
    const res = run("backup v1", { FAKE_PG: "none" });

    // Then
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("skipping the dump");
  });

  it("should write the dump of the running store before anything changes", () => {
    // Given / When
    const res = run("backup v1");
    const dumps = readdirSync(join(root, "backups"));

    // Then
    expect(res.status).toBe(0);
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatch(/^\d{8}T\d{6}Z-v1\.dump$/);
    expect(readFileSync(join(root, "backups", dumps[0]!), "utf8")).toBe("PGDMP-fake");
  });

  it("should stop the deploy and leave no partial file when pg_dump fails", () => {
    // Given / When
    const res = run("backup v1", { FAKE_DUMP: "fail" });

    // Then
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("pg_dump failed");
    expect(readdirSync(join(root, "backups"))).toEqual([]);
  });

  it("should stop the deploy when the dump comes out empty", () => {
    // Given / When
    const res = run("backup v1", { FAKE_DUMP: "empty" });

    // Then
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("produced nothing");
    expect(readdirSync(join(root, "backups"))).toEqual([]);
  });

  it("should keep only the fourteen newest dumps", () => {
    // Given
    mkdirSync(join(root, "backups"));
    for (let i = 0; i < 16; i++) {
      writeFileSync(join(root, `backups/2026010${String(i).padStart(2, "0")}-old.dump`), "x");
    }

    // When
    const res = run("backup v1");

    // Then
    expect(res.status).toBe(0);
    expect(readdirSync(join(root, "backups")).filter((f) => f.endsWith(".dump"))).toHaveLength(14);
  });
});
