import "reflect-metadata";
import { PgDatabase, redactUrl } from "@/db/postgres/database";
import { importSqlite, verifyImport } from "@/db/postgres/import-sqlite";
import { openDatabaseReadonly } from "@/db/sqlite/database";

const HELP = `
import-sqlite — copy authored memory from a SQLite store into a Postgres one.

  npm run import:sqlite -- --from PATH --to URL [--verify] [--verify-only]

  --from PATH     SQLite store to read, opened READ-ONLY. Use a copy made with
                  sqlite3 memory.db ".backup copy.db", never the live file.
  --to URL        Postgres database to write. Migrated first; re-running converges.
  --verify        After importing, compare per-table counts and content hashes.
  --verify-only   Compare without importing.
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
  const to = arg(argv, "--to");

  if (!from || !to) {
    console.error("import-sqlite: --from PATH and --to URL are required (see --help)");
    process.exitCode = 2;
    return;
  }

  const source = openDatabaseReadonly(from);
  const target = new PgDatabase({ url: to, poolMax: 2, readOnly: false });

  try {
    console.log(`from: ${from} (read-only)\nto:   ${redactUrl(to)}`);

    if (!argv.includes("--verify-only")) {
      const started = Date.now();
      const report = await importSqlite(source, target);

      console.log(`imported in ${String(Date.now() - started)} ms`);
      console.table(report.tables);
      console.log("dropped:", report.dropped);
    }

    if (argv.includes("--verify") || argv.includes("--verify-only")) {
      const verified = await verifyImport(source, target);

      console.table(verified.tables);
      console.log(verified.ok ? "verify: OK" : "verify: MISMATCH");

      if (!verified.ok) process.exitCode = 1;
    }
  } finally {
    source.close();
    await target.close();
  }
}

main().catch((err: unknown) => {
  console.error(`import-sqlite failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
