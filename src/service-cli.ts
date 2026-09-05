#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { resolveDaemonPath, resolveRunnerPath } from "@/runtime/ensure-daemon";
import { isMainModule } from "@/runtime/is-main";
import {
  defaultLaunchAgentSpec,
  isInstallableEntryPath,
  launchAgentPlistPath,
  renderLaunchAgent,
  SERVICE_LABELS,
  serviceLinkPath,
  type LaunchAgentSpec,
  type ServiceName,
} from "@/runtime/launch-agent";

// `cerebrium-service` — installs Cerebrium's supervised processes as launchd user agents so
// they survive reboots and crashes without a Claude session. This is the only supervisor:
// resident mode alone would leave a process nothing restarts or reaps.
const USAGE = `cerebrium-service <command> [daemon|runner|all]

  install     write the LaunchAgent(s) and load them (start now and at every login)
  uninstall   unload the LaunchAgent(s) and remove them
  status      report whether the agent(s) are installed and loaded
  print       write the rendered plist to stdout without touching the system

The service defaults to \`daemon\`. \`all\` covers both.

  daemon   the kernel, in resident mode: launchd owns the lifetime, so the model is
           loaded once instead of per session. Respawned whatever the exit.
  runner   the agent host. Respawned only after a FAILED exit, because a runner that
           config has disarmed exits cleanly at every launch and must stay down.
           Installing it does not arm it — \`runner.enabled\` does.
`;

const SERVICES: ServiceName[] = ["daemon", "runner"];

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };

    return { ok: false, output: (e.stderr ?? e.stdout ?? e.message).trim() };
  }
}

function domain(): string {
  return `gui/${String(process.getuid?.() ?? 0)}`;
}

function specFor(service: ServiceName): LaunchAgentSpec {
  return defaultLaunchAgentSpec(
    service,
    service === "daemon" ? resolveDaemonPath() : resolveRunnerPath(),
  );
}

function isLabelRegistered(label: string): boolean {
  return launchctl(["print", `${domain()}/${label}`]).ok;
}

function waitForLabelGone(label: string, attempts = 50, pauseMs = 100): boolean {
  for (let i = 0; i < attempts; i++) {
    if (!isLabelRegistered(label)) return true;

    // Deliberately synchronous: this is a short-lived CLI doing one thing in order, and
    // an async pause here would only make the sequencing harder to read.
    execFileSync("/bin/sleep", [String(pauseMs / 1000)], { stdio: "ignore" });
  }

  return !isLabelRegistered(label);
}

function install(service: ServiceName): number {
  if (process.platform !== "darwin") {
    process.stderr.write(`launchd is macOS-only; this platform is ${process.platform}\n`);

    return 1;
  }

  const spec = specFor(service);
  const plistPath = launchAgentPlistPath(undefined, spec.label);

  if (!isInstallableEntryPath(spec.entryTarget) || !existsSync(spec.entryTarget)) {
    process.stderr.write(
      `no built ${service} bundle to install (resolved ${spec.entryTarget}) — run ` +
        `\`npm run build\` and install with the built \`cerebrium-service\` bin\n`,
    );

    return 1;
  }

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(spec.entryPath), { recursive: true });
  rmSync(spec.entryPath, { force: true });
  symlinkSync(spec.entryTarget, spec.entryPath);
  writeFileSync(plistPath, renderLaunchAgent(spec), "utf8");

  // Idempotent: an existing agent must be booted out before the new plist can load,
  // and a first install has nothing to remove. `bootout` returns before launchd has
  // finished tearing the job down, and bootstrapping into that window fails with
  // "Bootstrap failed: 5: Input/output error" — so wait for the label to disappear.
  launchctl(["bootout", `${domain()}/${spec.label}`]);
  waitForLabelGone(spec.label);

  const loaded = launchctl(["bootstrap", domain(), plistPath]);

  if (!loaded.ok) {
    process.stderr.write(
      `wrote ${plistPath} but launchctl bootstrap failed: ${loaded.output}\n` +
        `the plist and link are in place, so \`launchctl bootstrap ${domain()} ${plistPath}\` ` +
        `will load it once launchd settles\n`,
    );

    return 1;
  }

  process.stdout.write(
    `installed ${spec.label}\n` +
      `  plist  ${plistPath}\n` +
      `  node   ${spec.nodePath}\n` +
      `  entry  ${spec.entryPath}\n` +
      `  target ${spec.entryTarget}\n` +
      `  home   ${spec.home}\n` +
      `  log    ${spec.logPath}\n`,
  );

  return 0;
}

function uninstall(service: ServiceName): number {
  const label = SERVICE_LABELS[service];
  const plistPath = launchAgentPlistPath(undefined, label);
  const removed = launchctl(["bootout", `${domain()}/${label}`]);
  const link = serviceLinkPath(service);

  rmSync(plistPath, { force: true });
  rmSync(link, { force: true });

  process.stdout.write(
    `uninstalled ${label}${removed.ok ? "" : " (was not loaded)"}\n` +
      `  removed ${plistPath}\n` +
      `  removed ${link}\n`,
  );

  return 0;
}

// A dangling link is the failure this reports: launchd keeps trying to run a path that no
// longer resolves, and the plist says nothing about why.
function describeLink(link: string): string {
  try {
    if (!lstatSync(link).isSymbolicLink()) return `${link} (not a link)`;
  } catch {
    return "not installed";
  }

  const target = readlinkSync(link);

  return existsSync(link) ? `${link} -> ${target}` : `${link} -> ${target} (TARGET MISSING)`;
}

function status(service: ServiceName): number {
  const label = SERVICE_LABELS[service];
  const plistPath = launchAgentPlistPath(undefined, label);
  const printed = launchctl(["print", `${domain()}/${label}`]);
  const pid = /\bpid = (\d+)/.exec(printed.output)?.[1];

  process.stdout.write(
    `agent   ${label}\n` +
      `  plist  ${existsSync(plistPath) ? plistPath : "not installed"}\n` +
      `  entry  ${describeLink(serviceLinkPath(service))}\n` +
      `  loaded ${printed.ok ? "yes" : "no"}\n` +
      `  pid    ${pid ?? "—"}\n`,
  );

  return 0;
}

function targetsOf(argument: string | undefined): ServiceName[] | null {
  if (argument === undefined) return ["daemon"];
  if (argument === "all") return SERVICES;

  return SERVICES.includes(argument as ServiceName) ? [argument as ServiceName] : null;
}

function main(argv: string[]): number {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);

    return 0;
  }

  const targets = targetsOf(argv[1]);

  if (targets === null) {
    process.stderr.write(`unknown service: ${argv[1]!}\n\n${USAGE}`);

    return 2;
  }

  // Worst wins: installing both must not report success because the second one worked.
  const over = (run: (service: ServiceName) => number): number =>
    targets.map(run).reduce((worst, code) => Math.max(worst, code), 0);

  switch (command) {
    case "install":
      return over(install);
    case "uninstall":
      return over(uninstall);
    case "status":
      return over(status);
    case "print":
      return over((service) => {
        process.stdout.write(renderLaunchAgent(specFor(service)));

        return 0;
      });
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);

      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`cerebrium-service failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

export { main as runServiceCli };
