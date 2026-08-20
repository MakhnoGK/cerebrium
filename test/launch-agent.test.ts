import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isInstallableDaemonPath,
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  renderLaunchAgent,
  stableNodePath,
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

describe("Stable node path", () => {
  // Homebrew's layout: the Cellar path is what process.execPath reports, and
  // /opt/homebrew/bin/node is a symlink to it.
  const cellar = "/opt/homebrew/Cellar/node/25.4.0/bin/node";
  const links: Record<string, string> = {
    "/opt/homebrew/bin/node": cellar,
    [cellar]: cellar,
  };
  const resolve = (p: string): string => {
    const hit = links[p];

    if (hit === undefined) throw new Error(`ENOENT: ${p}`);

    return hit;
  };

  it("should prefer an alias that resolves to the same binary", () => {
    // Given / When / Then
    expect(stableNodePath(cellar, { PATH: "/opt/homebrew/bin:/usr/bin" }, resolve)).toBe(
      "/opt/homebrew/bin/node",
    );
  });

  it("should keep the original when no alias on PATH is the same binary", () => {
    // Given — a node on PATH, but a different install than the running one.
    const other = (p: string): string => (p === cellar ? cellar : "/usr/bin/node-other");

    // When / Then
    expect(stableNodePath(cellar, { PATH: "/usr/bin" }, other)).toBe(cellar);
  });

  it("should keep the original when PATH is empty or unset", () => {
    // Given / When / Then
    expect(stableNodePath(cellar, {}, resolve)).toBe(cellar);
    expect(stableNodePath(cellar, { PATH: "" }, resolve)).toBe(cellar);
  });

  it("should prefer the shallowest alias when several match", () => {
    // Given — a deep symlink farm alongside the shallow one.
    const many: Record<string, string> = {
      ...links,
      "/opt/homebrew/opt/node/bin/node": cellar,
    };
    const resolveMany = (p: string): string => {
      const hit = many[p];

      if (hit === undefined) throw new Error(`ENOENT: ${p}`);

      return hit;
    };

    // When / Then
    expect(
      stableNodePath(cellar, { PATH: "/opt/homebrew/opt/node/bin:/opt/homebrew/bin" }, resolveMany),
    ).toBe("/opt/homebrew/bin/node");
  });

  it("should survive an unresolvable execPath", () => {
    // Given / When / Then
    expect(stableNodePath("/gone/node", { PATH: "/opt/homebrew/bin" }, resolve)).toBe("/gone/node");
  });
});
