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
import { resolveDaemonPath } from "@/runtime/ensure-daemon";
import { isMainModule } from "@/runtime/is-main";
import {
  daemonLinkPath,
  defaultLaunchAgentSpec,
  isInstallableDaemonPath,
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  renderLaunchAgent,
} from "@/runtime/launch-agent";

// `cerebrium-service` — installs the daemon as a launchd user agent so it survives
// reboots and crashes without a Claude session. This is the only supervisor: resident
// mode alone would leave a process nothing restarts or reaps.
const USAGE = `cerebrium-service <command>

  install     write the LaunchAgent and load it (daemon starts now and at every login)
  uninstall   unload the LaunchAgent and remove it
  status      report whether the agent is installed and loaded
  print       write the rendered plist to stdout without touching the system

The agent runs the daemon in resident mode: launchd owns the lifetime, so the model
is loaded once instead of per session.
`;

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

function install(): number {
  if (process.platform !== "darwin") {
    process.stderr.write(`launchd is macOS-only; this platform is ${process.platform}\n`);

    return 1;
  }

  const plistPath = launchAgentPlistPath();
  const spec = defaultLaunchAgentSpec(resolveDaemonPath());

  if (!isInstallableDaemonPath(spec.daemonTarget) || !existsSync(spec.daemonTarget)) {
    process.stderr.write(
      `no built daemon bundle to install (resolved ${spec.daemonTarget}) — run \`npm run build\` ` +
        `and install with the built \`cerebrium-service\` bin\n`,
    );

    return 1;
  }

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(spec.daemonPath), { recursive: true });
  rmSync(spec.daemonPath, { force: true });
  symlinkSync(spec.daemonTarget, spec.daemonPath);
  writeFileSync(plistPath, renderLaunchAgent(spec), "utf8");

  // Idempotent: an existing agent must be booted out before the new plist can load,
  // and a first install has nothing to remove.
  launchctl(["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);

  const loaded = launchctl(["bootstrap", domain(), plistPath]);

  if (!loaded.ok) {
    process.stderr.write(`wrote ${plistPath} but launchctl bootstrap failed: ${loaded.output}\n`);

    return 1;
  }

  process.stdout.write(
    `installed ${LAUNCH_AGENT_LABEL}\n` +
      `  plist  ${plistPath}\n` +
      `  node   ${spec.nodePath}\n` +
      `  daemon ${spec.daemonPath}\n` +
      `  target ${spec.daemonTarget}\n` +
      `  home   ${spec.home}\n` +
      `  log    ${spec.logPath}\n`,
  );

  return 0;
}

function uninstall(): number {
  const plistPath = launchAgentPlistPath();
  const removed = launchctl(["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  const link = daemonLinkPath();

  rmSync(plistPath, { force: true });
  rmSync(link, { force: true });

  process.stdout.write(
    `uninstalled ${LAUNCH_AGENT_LABEL}${removed.ok ? "" : " (was not loaded)"}\n` +
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

function status(): number {
  const plistPath = launchAgentPlistPath();
  const printed = launchctl(["print", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  const pid = /\bpid = (\d+)/.exec(printed.output)?.[1];

  process.stdout.write(
    `agent   ${LAUNCH_AGENT_LABEL}\n` +
      `  plist  ${existsSync(plistPath) ? plistPath : "not installed"}\n` +
      `  daemon ${describeLink(daemonLinkPath())}\n` +
      `  loaded ${printed.ok ? "yes" : "no"}\n` +
      `  pid    ${pid ?? "—"}\n`,
  );

  return 0;
}

function main(argv: string[]): number {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);

    return 0;
  }

  switch (command) {
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    case "status":
      return status();
    case "print":
      process.stdout.write(renderLaunchAgent(defaultLaunchAgentSpec(resolveDaemonPath())));

      return 0;
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
