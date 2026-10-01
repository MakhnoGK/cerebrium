#!/usr/bin/env node
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { PgDatabase, redactUrl } from "@cerebrium/kernel/db/postgres/database";
import {
  importSqlite,
  parseRepoMap,
  parseScope,
  remapCodeRefs,
  verifyImport,
  type ImportOptions,
  type RepoMap,
} from "@cerebrium/kernel/db/postgres/import-sqlite";
import { openDatabaseReadonly } from "@cerebrium/kernel/db/sqlite/database";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";

const HELP = `
import-sqlite — copy authored memory from a SQLite store into a Postgres one.

  npm run import:sqlite -- --from PATH --to URL [--projects LIST [--global]] [--verify] [--verify-only]
  node dist/import-sqlite.js --from PATH --to-file PATH [--verify]     (in the host image)
  node dist/import-sqlite.js --remap-code-refs --repo-map FILE --to-file PATH

  --from PATH     SQLite store to read, opened READ-ONLY. Use a copy made with
                  sqlite3 memory.db ".backup copy.db", never the live file.
  --to URL        Postgres database to write. Migrated first; re-running converges.
  --to-file PATH  Read the URL from a file instead (a container secret), so it never
                  appears in a process listing.
  --projects LIST Carry only these projects: comma-separated names, \`prefix*\` patterns
                  allowed. Edges, code_refs, candidates, annotations, events and review
                  decisions go only when every node they touch is carried; sessions,
                  principals and sweep runs go as they are. --verify compares against the
                  same subset.
  --global        With --projects, also carry project-less nodes.
  --verify        After importing, compare per-table counts and content hashes.
  --verify-only   Compare without importing.
  --repo-map FILE JSON object of old local repo name -> remote_key (host/owner/repo), built
                  on the machine that had the checkouts. code_refs of a repo it names get
                  that remote_key, so they resolve against the per-branch code index.
  --remap-code-refs
                  Only fill in remote_key on the code_refs already in the target, from
                  --repo-map. Nothing else is read or written.
  --help          This text.

Copied: authored nodes (invalidated included), revisions, search text, chunks and their
vectors (as vector space 1), edges between authored nodes, sessions, principals, events,
annotations, consolidation candidates among authored nodes and runs, review decisions, and
authored edges into the code mirror as code_refs. Not copied: the code mirror itself,
jobs, processes, worker leases and the embedding queue (the daemon rebuilds the queue).
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const from = arg(argv, "--from");
  const toFile = arg(argv, "--to-file");
  const to = toFile ? readFileSync(toFile, "utf8").trim() : arg(argv, "--to");
  const mapFile = arg(argv, "--repo-map");
  const repoMap: RepoMap | undefined = mapFile
    ? parseRepoMap(readFileSync(mapFile, "utf8"))
    : undefined;
  const projects = arg(argv, "--projects");

  if (argv.includes("--global") && projects === undefined) {
    console.error("import-sqlite: --global only narrows a --projects import");
    process.exitCode = 2;
    return;
  }

  const opts: ImportOptions = {
    ...(repoMap ? { repoMap } : {}),
    ...(projects !== undefined ? { scope: parseScope(projects, argv.includes("--global")) } : {}),
  };

  if (argv.includes("--remap-code-refs")) {
    if (!to || !repoMap) {
      console.error(
        "import-sqlite: --remap-code-refs needs --repo-map FILE and --to URL (or --to-file)",
      );
      process.exitCode = 2;
      return;
    }

    const target = new PgDatabase({ url: to, poolMax: 2, readOnly: false });

    try {
      console.log(`to: ${redactUrl(to)}`);
      console.table(await remapCodeRefs(target, repoMap));
    } finally {
      await target.close();
    }

    return;
  }

  if (!from || !to) {
    console.error(
      "import-sqlite: --from PATH and --to URL (or --to-file) are required (see --help)",
    );
    process.exitCode = 2;
    return;
  }

  const source = openDatabaseReadonly(from);
  const target = new PgDatabase({ url: to, poolMax: 2, readOnly: false });

  try {
    console.log(`from: ${from} (read-only)\nto:   ${redactUrl(to)}`);

    if (opts.scope) {
      console.log(
        `scope: ${opts.scope.projects.join(", ")}${opts.scope.global ? " + project-less" : ""}`,
      );
    }

    if (!argv.includes("--verify-only")) {
      const started = Date.now();
      const report = await importSqlite(source, target, opts);

      console.log(`imported in ${String(Date.now() - started)} ms`);
      console.table(report.tables);
      console.log("dropped:", report.dropped);
    }

    if (argv.includes("--verify") || argv.includes("--verify-only")) {
      const verified = await verifyImport(source, target, opts);

      console.table(verified.tables);
      console.log(verified.ok ? "verify: OK" : "verify: MISMATCH");

      if (!verified.ok) process.exitCode = 1;
    }
  } finally {
    source.close();
    await target.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`import-sqlite failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
