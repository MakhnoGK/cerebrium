import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

// Reports what each agent host still needs to use Cerebrium as memory. Read-only —
// see install/README.md for the procedure this checks against.

const HELP = `
agent-setup — report how far each agent host is from using Cerebrium as memory.

  npm run agent:setup -- [options]

  --host H     Host to inspect: ${HOSTS.join(" | ")} | all (default all).
  --repo PATH  Working tree the hosts should point at (default: this checkout).
  --home PATH  Home directory to inspect (default: $HOME). For testing a fake home.
  --json       Emit the plan as JSON instead of a table.
  --check      Exit non-zero if a detected host is missing anything.
  --help       This text.

Nothing is written. Surfaces reported per host: mcp, skill, rules, hook — see
install/hosts.md for where each one lives, and why all four are needed.
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

function main(): void {
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
  const plans = planAll({ ...base, env }, hosts);

  if (flag("json")) {
    process.stdout.write(`${JSON.stringify({ repoRoot, home, env, plans }, null, 2)}\n`);
  } else {
    report(plans, env, discovered !== null);
  }

  if (flag("check") && plans.some((p) => p.detected && pending(p).length > 0)) {
    process.exitCode = 1;
  }
}

main();
