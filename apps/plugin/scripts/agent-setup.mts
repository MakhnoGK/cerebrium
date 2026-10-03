import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableNodePath } from "@cerebrium/kernel/runtime/launch-agent";
import { applyHost, type Applied } from "@plugin/scripts/agent-apply";
import {
  DEFAULT_ENV_KEYS,
  defaultEnv,
  discoverEnv,
  HOSTS,
  isHostEnv,
  KERNEL_ENV_KEYS,
  kernelEnv,
  kernelProblems,
  pending,
  planAll,
  TRIAL_ENTRY,
  type HostId,
  type HostPlan,
  type PlanInput,
  type SurfaceStatus,
} from "@plugin/scripts/agent-hosts";
import { applyIndexRepos, planIndexRepos } from "@plugin/scripts/agent-index-repos";
import { assertNativeRuntime, resolveNodeRuntime } from "@plugin/scripts/agent-runtime";
import { verify } from "@plugin/scripts/agent-verify";

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

Against a Cerebrium host:

  npm run agent:setup -- --kernel tcp://HOST:PORT --token-file PATH [--host H] [--apply] [--verify]

  The cerebrium entry of every host runs apps/plugin/dist/server.js against that host. Its
  env holds the URL and the token file's path; the token itself is never read into config
  or output. Once registered, a later run without the two flags keeps them. --apply also
  removes the ${TRIAL_ENTRY} trial entry from Claude Code and Codex. --verify opens a real
  session on the host through the plugin bundle.

  --index-repo PATH (repeatable) opts a checkout into the host's per-branch code index:
  it is listed in ~/.cerebrium/plugin-index.json, the session-start hook indexes it in the
  background, and post-commit/checkout/merge/rewrite hooks in that repo re-index it. An
  existing hook is kept beside ours as <name>.cerebrium-prev and still runs first.

Core surfaces per host: mcp, skill, rules, hook. Claude Code also has a mod surface: the
code-nav mod in apps/plugin/install/claude-mod, listed in CLAUDE_CODE_PLUGIN_DIRS of
~/.claude/settings.json. Antigravity also has an explicit
permissions surface for the IDE and CLI configs; pi has an extension surface instead,
because it ships no MCP client and one extension delivers all four. See apps/plugin/install/hosts.md
for locations.
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

function options(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((arg, i) => {
    const value = process.argv[i + 1];
    if (arg === `--${name}` && value !== undefined) out.push(value);
  });
  return out;
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

function report(
  plans: HostPlan[],
  env: Record<string, string>,
  source: string,
  nodePath: string,
): void {
  process.stdout.write(`\nNode runtime: ${nodePath}\n`);
  process.stdout.write(`\nEnvironment (${source}):\n`);
  for (const key of isHostEnv(env) ? KERNEL_ENV_KEYS : DEFAULT_ENV_KEYS) {
    if (env[key] !== undefined) process.stdout.write(`  ${key}=${env[key]}\n`);
  }

  for (const plan of plans) {
    const status = plan.detected ? "" : "  (not installed on this machine)";
    process.stdout.write(`\n${plan.host}${status}\n`);
    for (const s of plan.surfaces) {
      process.stdout.write(`  ${GLYPH[s.status]} ${s.surface.padEnd(9)} ${s.detail}\n`);
      process.stdout.write(`    ${s.target}\n`);
    }
    for (const note of plan.notes) process.stdout.write(`  → ${note}\n`);
  }

  const outstanding = plans.filter((p) => p.detected && pending(p).length > 0);
  process.stdout.write(
    outstanding.length === 0
      ? "\nEvery detected host is set up.\n"
      : `\nIncomplete: ${outstanding.map((p) => p.host).join(", ")}. See apps/plugin/install/README.md.\n`,
  );
}

function indexRepos(repoRoot: string, home: string, input: PlanInput): void {
  const repos = options("index-repo");
  if (repos.length === 0) return;
  if (!isHostEnv(input.env)) {
    process.stderr.write("--index-repo needs a host-backed entry (--kernel and --token-file)\n");
    process.exitCode = 2;
    return;
  }
  const request = {
    home,
    repoRoot,
    nodePath: input.nodePath,
    kernelUrl: input.env.MEMORY_KERNEL_URL!,
    tokenFile: input.env.MEMORY_KERNEL_TOKEN_FILE ?? "",
    repos,
  };
  const outcomes = flag("apply") ? applyIndexRepos(request) : planIndexRepos(request);
  process.stdout.write("\nCode index on the host:\n");
  for (const o of outcomes) {
    process.stdout.write(`  ${o.ok ? "✓" : flag("apply") ? "✗" : "·"} ${o.repo}: ${o.detail}\n`);
    if (!o.ok && flag("apply")) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (flag("help")) {
    process.stdout.write(HELP);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(option("repo", join(here, "..", "..", "..")));
  const home = resolve(option("home", homedir()));
  let nodePath: string;
  try {
    nodePath = resolveNodeRuntime(repoRoot);
  } catch (err) {
    process.stderr.write(`Runtime error: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const requested = option("host", "all");
  const hosts: HostId[] =
    requested === "all" ? [...HOSTS] : HOSTS.filter((h) => h === requested).map((h) => h);

  if (hosts.length === 0) {
    process.stderr.write(`Unknown host "${requested}". Known: ${HOSTS.join(", ")}, all.\n`);
    process.exitCode = 2;
    return;
  }

  const kernelUrl = option("kernel", "");
  const tokenFile = option("token-file", "");
  if ((kernelUrl === "") !== (tokenFile === "")) {
    process.stderr.write("--kernel and --token-file go together\n");
    process.exitCode = 2;
    return;
  }
  if (kernelUrl !== "") {
    const problems = kernelProblems(kernelUrl, resolve(tokenFile));
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const base: PlanInput = { home, repoRoot, nodePath, env: {}, hasCommand };
  const discovered = kernelUrl === "" ? discoverEnv(base) : null;
  const env =
    kernelUrl !== ""
      ? kernelEnv(kernelUrl, resolve(tokenFile))
      : (discovered ?? defaultEnv(home, repoRoot));
  const input: PlanInput = {
    ...base,
    env,
    nodePath: isHostEnv(env) ? stableNodePath(nodePath) : nodePath,
  };
  const source =
    kernelUrl !== ""
      ? "from --kernel and --token-file"
      : discovered !== null
        ? "reused from an existing registration"
        : "defaults";

  if (flag("apply")) {
    if (!isHostEnv(env)) {
      try {
        assertNativeRuntime(repoRoot, nodePath);
      } catch (err) {
        process.stderr.write(`Runtime preflight failed: ${String(err)}\n`);
        process.exitCode = 1;
        return;
      }
    }
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
    process.stdout.write(
      `${JSON.stringify({ repoRoot, home, nodePath: input.nodePath, env, plans }, null, 2)}\n`,
    );
  } else {
    report(plans, env, source, input.nodePath);
  }

  indexRepos(repoRoot, home, input);

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
