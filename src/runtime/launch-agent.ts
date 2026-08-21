import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join, join as joinPath } from "node:path";
import { cerebriumHome } from "@/runtime/paths";

export const LAUNCH_AGENT_LABEL = "net.obrio.cerebrium.daemon";

// The pid launchd supervises for this agent, or null when it supervises none — the agent is
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
): number | null {
  let printed: string;

  try {
    printed = run(`launchctl print gui/${String(uid)}/${LAUNCH_AGENT_LABEL}`);
  } catch {
    return null;
  }

  const match = /\bpid\s*=\s*(\d+)/.exec(printed);

  return match === null ? null : Number.parseInt(match[1]!, 10);
}

export interface LaunchAgentSpec {
  // Absolute path to the node binary and to the daemon entry point. Both are captured at
  // install time: launchd runs with a minimal PATH and cannot find either by name.
  nodePath: string;
  // What the plist runs: the stable link under $CEREBRIUM_HOME/bin, never the build output
  // directly, so the agent does not carry a working-tree path.
  daemonPath: string;
  // What that link points at. Node resolves an entry point to its realpath, so the bundle
  // still finds its own migrations and its unbundled native dependencies.
  daemonTarget: string;
  home: string;
  logPath: string;
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

export function launchAgentPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

// The one indirection the installed agent depends on. Re-pointing this link moves the
// agent to a different build without touching the plist or reloading it.
export function daemonLinkPath(home = cerebriumHome()): string {
  return join(home, "bin", "daemon.js");
}

export function defaultLaunchAgentSpec(daemonTarget: string): LaunchAgentSpec {
  const home = cerebriumHome();

  return {
    nodePath: stableNodePath(),
    daemonPath: daemonLinkPath(home),
    daemonTarget,
    home,
    logPath: join(home, "daemon.log"),
  };
}

// launchd runs the bare node binary, which cannot execute TypeScript. Run from source
// the daemon resolver finds `src/daemon.ts`, which exists — so existence is not the
// check that matters when installing, the extension is.
export function isInstallableDaemonPath(daemonPath: string): boolean {
  return daemonPath.endsWith(".js");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// `KeepAlive: true` and idle-exit are mutually exclusive: a daemon that exits cleanly
// after five idle minutes would be respawned forever, reloading the model each time.
// That is why MEMORY_DAEMON_RESIDENT is not optional here.
export function renderLaunchAgent(spec: LaunchAgentSpec): string {
  const env: [string, string][] = [
    ["CEREBRIUM_HOME", spec.home],
    ["MEMORY_DAEMON_RESIDENT", "1"],
  ];

  const args = [spec.nodePath, spec.daemonPath]
    .map((a) => `      <string>${xmlEscape(a)}</string>`)
    .join("\n");

  const envEntries = env
    .map(([k, v]) => `      <key>${k}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
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
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.logPath)}</string>
  </dict>
</plist>
`;
}
