#!/usr/bin/env node
import "reflect-metadata";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { START_SESSION } from "@cerebrium/kernel/application/use-cases";
import { buildRemoteContainer } from "@cerebrium/kernel/remote-container";
import { ClientIdentity } from "@cerebrium/kernel/runtime/client-identity";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";
import { cerebriumHome } from "@cerebrium/kernel/runtime/paths";
import { codeCalls } from "@plugin/src/code/client-index-code";
import { indexCheckout } from "@plugin/src/code/client-indexer";
import { repoRoot } from "@plugin/src/code/git";
import { readIndexConfig } from "@plugin/src/code/index-config";

const HELP = `
cerebrium-plugin index — index a git checkout on the Cerebrium host.

  node index.js [PATH] [--detach] [--quiet] [--min-interval SECONDS]

  PATH                 The checkout (default: the working directory).
  --detach             Run in the background and return at once (for git hooks).
  --quiet              Print nothing; exit 0 when there is nothing to do.
  --min-interval S     Skip if this checkout was indexed less than S seconds ago (default 0).

The host comes from MEMORY_KERNEL_URL + MEMORY_KERNEL_TOKEN_FILE, or from
~/.cerebrium/plugin-index.json (written by agent:setup --index-repo).
`;

interface Args {
  dir: string;
  detach: boolean;
  quiet: boolean;
  minIntervalMs: number;
}

function parseArgs(argv: string[]): Args | null {
  if (argv.includes("--help")) return null;

  const at = argv.indexOf("--min-interval");
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(at !== -1 && i === at + 1));

  return {
    dir: positional[0] ?? process.cwd(),
    detach: argv.includes("--detach"),
    quiet: argv.includes("--quiet"),
    minIntervalMs: at === -1 ? 0 : Math.max(0, Number(argv[at + 1] ?? "0") * 1000),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function run(args: Args): Promise<number> {
  const say = (line: string): void => {
    if (!args.quiet) process.stdout.write(`${line}\n`);
  };
  const home = cerebriumHome();

  if (!process.env.MEMORY_KERNEL_URL) {
    const config = readIndexConfig(home);

    if (config === null) {
      say("no Cerebrium host configured (MEMORY_KERNEL_URL or ~/.cerebrium/plugin-index.json)");

      return args.quiet ? 0 : 1;
    }

    process.env.MEMORY_KERNEL_URL = config.kernel;
    process.env.MEMORY_KERNEL_TOKEN_FILE = config.token_file;
  }

  const root = await repoRoot(args.dir);

  if (root === null) {
    say(`${args.dir} is not inside a git checkout`);

    return args.quiet ? 0 : 1;
  }

  const state = join(home, "index");
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const lock = join(state, `${key}.lock`);
  const stamp = join(state, `${key}.json`);

  mkdirSync(state, { recursive: true });

  if (existsSync(lock) && alive(Number(readFileSync(lock, "utf8")))) {
    say(`${root} is already being indexed`);

    return 0;
  }

  if (args.minIntervalMs > 0 && existsSync(stamp)) {
    const last = Date.parse((JSON.parse(readFileSync(stamp, "utf8")) as { at?: string }).at ?? "");

    if (Date.now() - last < args.minIntervalMs) return 0;
  }

  writeFileSync(lock, String(process.pid));

  try {
    const container = buildRemoteContainer({ requireUrl: true });

    container.resolve(ClientIdentity).set({ client: "cerebrium-index", version: "1" });

    const { session_id } = await container.resolve(START_SESSION).invoke({
      project: null,
      client: { client: "cerebrium-index", version: "1" },
    });
    const done = await indexCheckout(root, session_id, codeCalls(container));

    writeFileSync(
      stamp,
      JSON.stringify({ at: new Date().toISOString(), commit: done.result.commit }),
    );
    say(
      `${done.checkout.display_name}@${done.result.branch}: ${String(done.result.files)} files, ` +
        `${String(done.uploaded)} uploaded, ${String(done.result.units_parsed)} parsed, ` +
        `${String(done.result.files_changed)} changed, ${String(done.result.files_removed)} removed`,
    );

    return 0;
  } finally {
    rmSync(lock, { force: true });
  }
}

function detach(argv: string[]): void {
  const logs = join(cerebriumHome(), "logs");

  mkdirSync(logs, { recursive: true });

  const out = openSync(join(logs, "index.log"), "a");
  const child = spawn(
    process.execPath,
    [process.argv[1]!, ...argv.filter((a) => a !== "--detach")],
    {
      detached: true,
      stdio: ["ignore", out, out],
    },
  );

  child.unref();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args === null) {
    process.stdout.write(HELP);

    return;
  }

  if (args.detach) {
    detach(argv);

    return;
  }

  process.exitCode = await run(args);
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`cerebrium index: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
