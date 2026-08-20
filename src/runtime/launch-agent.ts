import { homedir } from "node:os";
import { join } from "node:path";
import { cerebriumHome } from "@/runtime/paths";

export const LAUNCH_AGENT_LABEL = "net.obrio.cerebrium.daemon";

export interface LaunchAgentSpec {
  // Absolute path to the node binary and to the daemon bundle. Both are captured at
  // install time: launchd runs with a minimal PATH and cannot find either by name.
  nodePath: string;
  daemonPath: string;
  home: string;
  logPath: string;
}

export function launchAgentPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function defaultLaunchAgentSpec(daemonPath: string): LaunchAgentSpec {
  const home = cerebriumHome();

  return { nodePath: process.execPath, daemonPath, home, logPath: join(home, "daemon.log") };
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
