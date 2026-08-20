import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isInstallableDaemonPath,
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  renderLaunchAgent,
  type LaunchAgentSpec,
} from "@/runtime/launch-agent";

const spec: LaunchAgentSpec = {
  nodePath: "/opt/homebrew/bin/node",
  daemonPath: "/Users/x/projects/cerebrium/dist/daemon.js",
  home: "/Users/x/.cerebrium",
  logPath: "/Users/x/.cerebrium/daemon.log",
};

describe("LaunchAgent plist", () => {
  it("should always set resident mode, because KeepAlive plus idle-exit is a respawn loop", () => {
    // Given / When
    const plist = renderLaunchAgent(spec);

    // Then
    expect(plist).toContain("<key>MEMORY_DAEMON_RESIDENT</key>");
    expect(plist).toContain("<string>1</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
  });

  it("should pin absolute paths for node and the daemon bundle", () => {
    // Given / When
    const plist = renderLaunchAgent(spec);

    // Then
    expect(plist).toContain(`<string>${spec.nodePath}</string>`);
    expect(plist).toContain(`<string>${spec.daemonPath}</string>`);
    expect(plist).toContain(`<key>CEREBRIUM_HOME</key>\n      <string>${spec.home}</string>`);
  });

  it("should escape a path that would otherwise break the XML", () => {
    // Given
    const hostile = { ...spec, home: "/Users/a&b/<c>/.cerebrium" };

    // When
    const plist = renderLaunchAgent(hostile);

    // Then
    expect(plist).toContain("/Users/a&amp;b/&lt;c&gt;/.cerebrium");
    expect(plist).not.toContain("/Users/a&b/<c>");
  });

  it("should refuse a TypeScript daemon path, which plain node cannot execute", () => {
    // Given / When / Then — running from source resolves src/daemon.ts, and that file
    // exists, so existence is not the check that catches this.
    expect(isInstallableDaemonPath("/x/dist/daemon.js")).toBe(true);
    expect(isInstallableDaemonPath("/x/src/daemon.ts")).toBe(false);
  });

  it("should place the plist in the per-user LaunchAgents directory", () => {
    // Given / When / Then
    expect(launchAgentPlistPath("/Users/x")).toBe(
      join("/Users/x", "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    );
  });
});
