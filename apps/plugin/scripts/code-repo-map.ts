import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { openDatabaseReadonly } from "@cerebrium/kernel/db/sqlite/database";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";
import { remoteKeyOf } from "@plugin/src/code/git";

const HELP = `
code-repo-map — name the remote_key of each repo a SQLite store indexed, for import-sqlite.

  npm run code:repo-map -- --from SNAPSHOT [--repos cerebrium,toonspace*] [--out FILE]

  --from PATH   A copy of the store (sqlite3 memory.db ".backup copy.db"), opened read-only.
  --repos LIST  Old repo names to map; a trailing * matches a prefix (default cerebrium,toonspace*).
  --out FILE    Write the JSON map here instead of stdout.
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
}

export function wanted(patterns: string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const from = arg(argv, "--from");

  if (argv.includes("--help") || !from) {
    process.stdout.write(HELP);
    process.exitCode = from ? 0 : 2;
    return;
  }

  const patterns = (arg(argv, "--repos") ?? "cerebrium,toonspace*").split(",").map((p) => p.trim());
  const db = openDatabaseReadonly(from);
  const rows = db.prepare("SELECT repo, root FROM code_repos ORDER BY repo").all() as {
    repo: string;
    root: string | null;
  }[];

  db.close();

  const map: Record<string, string> = {};

  for (const { repo, root } of rows) {
    if (!wanted(patterns, repo)) continue;

    if (!root || !existsSync(root)) {
      process.stderr.write(`skip ${repo}: root ${root ?? "(none)"} is not on this machine\n`);
      continue;
    }

    let url: string;

    try {
      url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
        encoding: "utf8",
      }).trim();
    } catch {
      process.stderr.write(`skip ${repo}: ${root} has no origin remote\n`);
      continue;
    }

    const key = await remoteKeyOf(url);

    if (key === null) {
      process.stderr.write(`skip ${repo}: cannot read a remote_key from ${url}\n`);
      continue;
    }

    map[repo] = key;
  }

  const json = `${JSON.stringify(map, null, 2)}\n`;
  const out = arg(argv, "--out");

  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`code-repo-map failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
