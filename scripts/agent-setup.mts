import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyHost, type Applied } from "@scripts/agent-apply";
import {
  DEFAULT_ENV_KEYS,
  defaultEnv,
  discoverEnv,
  HOSTS,
  pending,
  planAll,
  type HostId,
  type HostPlan,
  type PlanInput,
  type SurfaceStatus,
} from "@scripts/agent-hosts";
import { verify } from "@scripts/agent-verify";

// Reports — and with --apply, installs — what each agent host needs to use Cerebrium as
// memory. See install/README.md for the procedure this checks against.

const HELP = `
agent-setup — report or install what each agent host needs to use Cerebrium as memory.

  npm run agent:setup -- [options]

  --host H     Host to act on: ${HOSTS.join(" | ")} | all (default all).
  --apply      Write the missing surfaces. Without it, nothing is written.
  --force      Move an existing skill *copy* aside (kept, never deleted) and link instead.
  --repo PATH  Working tree the hosts should point at (default: this checkout).
  --home PATH  Home directory to act on (default: $HOME). For testing a fake home.
  --verify     Prove it works: boot the bundle, call session_start against a throwaway
               store, and run the hook script. Never touches the real memory. Exits
               non-zero if any of that fails.
  --json       Emit the plan as JSON instead of a table.
  --check      Exit non-zero if a detected host is missing a surface.
  --help       This text.

Core surfaces per host: mcp, skill, rules, hook. Antigravity also has an explicit
permissions surface for the IDE and CLI configs. See install/hosts.md for locations.
--apply never touches the database, deletes nothing, and edits rules files you own only
between the cerebrium:start/end markers.
`;

const GLYPH: Record<SurfaceStatus, string> = {
  ok: "✓",
  missing: "·",
  stale: "!",
  conflict: "✗",
  manual: "→",
};

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function outcomeGlyph(applied: Applied): string {
  if (applied.outcome === "failed") return "✗";
  return applied.outcome === "skipped" ? "→" : "✓";
}

function report(plans: HostPlan[], env: Record<string, string>, discovered: boolean): void {
  const source = discovered ? "reused from an existing registration" : "defaults";
  process.stdout.write(`\nEnvironment (${source}):\n`);
  for (const key of DEFAULT_ENV_KEYS) {
    if (env[key] !== undefined) process.stdout.write(`  ${key}=${env[key]}\n`);
  }

  for (const plan of plans) {
    const status = plan.detected ? "" : "  (not installed on this machine)";
    process.stdout.write(`\n${plan.host}${status}\n`);
    for (const s of plan.surfaces) {
      process.stdout.write(`  ${GLYPH[s.status]} ${s.surface.padEnd(6)} ${s.detail}\n`);
      process.stdout.write(`    ${s.target}\n`);
    }
    for (const note of plan.notes) process.stdout.write(`  → ${note}\n`);
  }

  const outstanding = plans.filter((p) => p.detected && pending(p).length > 0);
  process.stdout.write(
    outstanding.length === 0
      ? "\nEvery detected host is set up.\n"
      : `\nIncomplete: ${outstanding.map((p) => p.host).join(", ")}. See install/README.md.\n`,
  );
}

async function main(): Promise<void> {
  if (flag("help")) {
    process.stdout.write(HELP);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(option("repo", join(here, "..")));
  const home = resolve(option("home", homedir()));
  const requested = option("host", "all");
  const hosts: HostId[] =
    requested === "all" ? [...HOSTS] : HOSTS.filter((h) => h === requested).map((h) => h);

  if (hosts.length === 0) {
    process.stderr.write(`Unknown host "${requested}". Known: ${HOSTS.join(", ")}, all.\n`);
    process.exitCode = 2;
    return;
  }

  const base: PlanInput = { home, repoRoot, env: {}, hasCommand };
  const discovered = discoverEnv(base);
  const env = discovered ?? defaultEnv(home, repoRoot);
  const input: PlanInput = { ...base, env };

  if (flag("apply")) {
    let unresolved = false;
    for (const host of hosts) {
      const applied = applyHost(host, input, { force: flag("force"), run });
      process.stdout.write(`\n${host}\n`);
      if (applied.length === 0) process.stdout.write("  nothing to do\n");
      for (const a of applied) {
        process.stdout.write(`  ${outcomeGlyph(a)} ${a.detail}\n`);
        if (a.outcome === "failed" || a.outcome === "skipped") unresolved = true;
      }
    }
    if (unresolved) process.exitCode = 1;
    process.stdout.write("\nRe-checking:\n");
  }

  const plans = planAll(input, hosts);

  if (flag("json")) {
    process.stdout.write(`${JSON.stringify({ repoRoot, home, env, plans }, null, 2)}\n`);
  } else {
    report(plans, env, discovered !== null);
  }

  if (flag("verify")) {
    process.stdout.write("\nVerification:\n");
    for (const result of await verify(input, hosts)) {
      if (!result.ok) process.exitCode = 1;
      process.stdout.write(`  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}\n`);
    }
  }

  if (flag("check") && plans.some((p) => p.detected && pending(p).length > 0)) {
    process.exitCode = 1;
  }
}

await main();
