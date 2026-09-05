import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join, join as joinPath } from "node:path";
import { cerebriumHome } from "@/runtime/paths";

export const LAUNCH_AGENT_LABEL = "net.obrio.cerebrium.daemon";
export const RUNNER_AGENT_LABEL = "net.obrio.cerebrium.runner";

// The two supervised processes. They are separate agents because they fail differently: the
// daemon owns the database and must always be up, the runner spends the owner's subscription
// and must not be respawned into a loop when it exits on purpose.
export type ServiceName = "daemon" | "runner";

export const SERVICE_LABELS: Record<ServiceName, string> = {
  daemon: LAUNCH_AGENT_LABEL,
  runner: RUNNER_AGENT_LABEL,
};

// The pid launchd supervises for an agent, or null when it supervises none — the agent is
// not installed, launchd is not there to ask, or it answered something unparseable. Asking
// launchd is the only way to tell the daemon it manages from one a session or the desktop
// app started: both are the same executable on the same database.
//
// `run` is a parameter so the parse can be tested against real `launchctl print` output
// without a launchd to run it.
export function launchdPid(
  run: (command: string) => string = (command) =>
    execSync(command, { encoding: "utf8", stdio: "pipe" }),
  uid: number = userInfo().uid,
  label: string = LAUNCH_AGENT_LABEL,
): number | null {
  let printed: string;

  try {
    printed = run(`launchctl print gui/${String(uid)}/${label}`);
  } catch {
    return null;
  }

  const match = /\bpid\s*=\s*(\d+)/.exec(printed);

  return match === null ? null : Number.parseInt(match[1]!, 10);
}

export interface LaunchAgentSpec {
  label: string;
  // Absolute path to the node binary and to the entry point. Both are captured at install
  // time: launchd runs with a minimal PATH and cannot find either by name.
  nodePath: string;
  // What the plist runs: the stable link under $CEREBRIUM_HOME/bin, never the build output
  // directly, so the agent does not carry a working-tree path.
  entryPath: string;
  // What that link points at. Node resolves an entry point to its realpath, so the bundle
  // still finds its own migrations and its unbundled native dependencies.
  entryTarget: string;
  home: string;
  logPath: string;
  env: [string, string][];
  // `always` respawns whatever the exit. `onFailure` leaves a clean exit alone, which is
  // what a runner disabled by config does at every launch.
  keepAlive: "always" | "onFailure";
  throttleSeconds?: number;
}

// `process.execPath` resolves symlinks, so on Homebrew it yields a version-pinned path
// like /opt/homebrew/Cellar/node/25.4.0/bin/node. launchd stores it verbatim, and the next
// node upgrade deletes that directory — the agent then fails at every launch with nothing
// in the plist to hint why.
//
// Look for an alias on PATH that resolves to the very same binary and prefer the shallowest
// one, which is how the stable /opt/homebrew/bin/node wins over the Cellar path. Nothing is
// guessed: a candidate is only used when it provably points at the running binary today.
export function stableNodePath(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  resolve: (p: string) => string = realpathSync,
): string {
  let real: string;

  try {
    real = resolve(execPath);
  } catch {
    return execPath;
  }

  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length)
    .map((dir) => joinPath(dir, "node"))
    .filter((candidate) => {
      try {
        return resolve(candidate) === real;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  return candidates[0] ?? execPath;
}

export function launchAgentPlistPath(home = homedir(), label = LAUNCH_AGENT_LABEL): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

// The one indirection an installed agent depends on. Re-pointing this link moves the agent
// to a different build without touching the plist or reloading it.
export function serviceLinkPath(service: ServiceName, home = cerebriumHome()): string {
  return join(home, "bin", `${service}.js`);
}

export function daemonLinkPath(home = cerebriumHome()): string {
  return serviceLinkPath("daemon", home);
}

export function runnerLinkPath(home = cerebriumHome()): string {
  return serviceLinkPath("runner", home);
}

// launchd runs the bare node binary, which cannot execute TypeScript. Run from source the
// resolvers find `src/daemon.ts`, which exists — so existence is not the check that matters
// when installing, the extension is.
export function isInstallableEntryPath(entryPath: string): boolean {
  return entryPath.endsWith(".js");
}

export function defaultLaunchAgentSpec(
  service: ServiceName,
  entryTarget: string,
  env: NodeJS.ProcessEnv = process.env,
): LaunchAgentSpec {
  const home = cerebriumHome();
  const shared: [string, string][] = [["CEREBRIUM_HOME", home]];

  return service === "daemon"
    ? {
        label: LAUNCH_AGENT_LABEL,
        nodePath: stableNodePath(),
        entryPath: serviceLinkPath("daemon", home),
        entryTarget,
        home,
        logPath: join(home, "daemon.log"),
        // `KeepAlive: true` and idle-exit are mutually exclusive: a daemon that exits
        // cleanly after five idle minutes would be respawned forever, reloading the model
        // each time. That is why MEMORY_DAEMON_RESIDENT is not optional here.
        env: [...shared, ["MEMORY_DAEMON_RESIDENT", "1"]],
        keepAlive: "always",
      }
    : {
        label: RUNNER_AGENT_LABEL,
        nodePath: stableNodePath(),
        entryPath: serviceLinkPath("runner", home),
        entryTarget,
        home,
        logPath: join(home, "runner.log"),
        // The runner spawns an external agent CLI by name, and launchd's PATH is
        // /usr/bin:/bin:/usr/sbin:/sbin — which holds no Homebrew binary. Without the
        // installing shell's PATH carried into the plist the spawn fails with ENOENT at
        // every claim, long after the job row says the work began.
        env: [...shared, ["PATH", env.PATH ?? ""]],
        keepAlive: "onFailure",
        throttleSeconds: 60,
      };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function keepAliveXml(spec: LaunchAgentSpec): string {
  return spec.keepAlive === "always"
    ? "    <key>KeepAlive</key>\n    <true/>"
    : [
        "    <key>KeepAlive</key>",
        "    <dict>",
        "      <key>SuccessfulExit</key>",
        "      <false/>",
        "    </dict>",
      ].join("\n");
}

export function renderLaunchAgent(spec: LaunchAgentSpec): string {
  const args = [spec.nodePath, spec.entryPath]
    .map((a) => `      <string>${xmlEscape(a)}</string>`)
    .join("\n");

  const envEntries = spec.env
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join("\n");

  const throttle =
    spec.throttleSeconds === undefined
      ? ""
      : `    <key>ThrottleInterval</key>\n    <integer>${String(spec.throttleSeconds)}</integer>\n`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
${keepAliveXml(spec)}
${throttle}    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
  </dict>
</plist>
`;
}
