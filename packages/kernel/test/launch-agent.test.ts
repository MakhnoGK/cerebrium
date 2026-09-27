import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  daemonLinkPath,
  isInstallableEntryPath,
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  launchdPid,
  renderLaunchAgent,
  RUNNER_AGENT_LABEL,
  runnerLinkPath,
  stableNodePath,
  type LaunchAgentSpec,
} from "@/runtime/launch-agent";

const spec: LaunchAgentSpec = {
  label: LAUNCH_AGENT_LABEL,
  nodePath: "/opt/homebrew/bin/node",
  entryPath: "/Users/x/.cerebrium/bin/daemon.js",
  entryTarget: "/Users/x/projects/cerebrium/dist/daemon.js",
  home: "/Users/x/.cerebrium",
  logPath: "/Users/x/.cerebrium/daemon.log",
  env: [
    ["CEREBRIUM_HOME", "/Users/x/.cerebrium"],
    ["MEMORY_DAEMON_RESIDENT", "1"],
  ],
  keepAlive: "always",
};

const runnerSpec: LaunchAgentSpec = {
  label: RUNNER_AGENT_LABEL,
  nodePath: "/opt/homebrew/bin/node",
  entryPath: "/Users/x/.cerebrium/bin/runner.js",
  entryTarget: "/Users/x/projects/cerebrium/dist/runner.js",
  home: "/Users/x/.cerebrium",
  logPath: "/Users/x/.cerebrium/runner.log",
  env: [
    ["CEREBRIUM_HOME", "/Users/x/.cerebrium"],
    ["PATH", "/opt/homebrew/bin:/usr/bin:/bin"],
  ],
  keepAlive: "onFailure",
  throttleSeconds: 60,
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

  it("should pin absolute paths for node and the daemon entry point", () => {
    // Given / When
    const plist = renderLaunchAgent(spec);

    // Then
    expect(plist).toContain(`<string>${spec.nodePath}</string>`);
    expect(plist).toContain(`<string>${spec.entryPath}</string>`);
    expect(plist).toContain(`<key>CEREBRIUM_HOME</key>\n      <string>${spec.home}</string>`);
  });

  it("should run the stable link, never the build directory, so no working-tree path is baked in", () => {
    // Given / When
    const plist = renderLaunchAgent(spec);

    // Then
    expect(plist).toContain("<string>/Users/x/.cerebrium/bin/daemon.js</string>");
    expect(plist).not.toContain(spec.entryTarget);
  });

  it("should place the daemon link under the install root", () => {
    // Given / When / Then
    expect(daemonLinkPath("/Users/x/.cerebrium")).toBe("/Users/x/.cerebrium/bin/daemon.js");
  });

  it("should escape a path that would otherwise break the XML", () => {
    // Given
    const hostile: LaunchAgentSpec = {
      ...spec,
      home: "/Users/a&b/<c>/.cerebrium",
      env: [["CEREBRIUM_HOME", "/Users/a&b/<c>/.cerebrium"]],
    };

    // When
    const plist = renderLaunchAgent(hostile);

    // Then
    expect(plist).toContain("/Users/a&amp;b/&lt;c&gt;/.cerebrium");
    expect(plist).not.toContain("/Users/a&b/<c>");
  });

  it("should refuse a TypeScript daemon path, which plain node cannot execute", () => {
    // Given / When / Then — running from source resolves src/daemon.ts, and that file
    // exists, so existence is not the check that catches this.
    expect(isInstallableEntryPath("/x/dist/daemon.js")).toBe(true);
    expect(isInstallableEntryPath("/x/src/daemon.ts")).toBe(false);
  });

  it("should place the plist in the per-user LaunchAgents directory", () => {
    // Given / When / Then
    expect(launchAgentPlistPath("/Users/x")).toBe(
      join("/Users/x", "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    );
  });

  it("should give each service its own plist, so installing one cannot overwrite the other", () => {
    // Given / When / Then
    expect(launchAgentPlistPath("/Users/x", RUNNER_AGENT_LABEL)).toBe(
      join("/Users/x", "Library", "LaunchAgents", `${RUNNER_AGENT_LABEL}.plist`),
    );
    expect(launchAgentPlistPath("/Users/x", RUNNER_AGENT_LABEL)).not.toBe(
      launchAgentPlistPath("/Users/x"),
    );
  });
});

describe("Runner LaunchAgent plist", () => {
  it("should leave a clean exit alone, because a disarmed runner exits 0 at every launch", () => {
    // Given / When
    const plist = renderLaunchAgent(runnerSpec);

    // Then — `KeepAlive: true` here would respawn a config-disabled runner forever.
    expect(plist).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(plist).not.toContain("<key>KeepAlive</key>\n    <true/>");
  });

  it("should bound how fast a crash-looping runner comes back", () => {
    // Given / When / Then
    expect(renderLaunchAgent(runnerSpec)).toContain(
      "<key>ThrottleInterval</key>\n    <integer>60</integer>",
    );
  });

  it("should carry a PATH, because the runner spawns its agent CLI by name", () => {
    // Given / When
    const plist = renderLaunchAgent(runnerSpec);

    // Then — launchd's own PATH holds no Homebrew binary, so the spawn would be ENOENT.
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
  });

  it("should never put the daemon's resident flag on the runner", () => {
    // Given / When / Then
    expect(renderLaunchAgent(runnerSpec)).not.toContain("MEMORY_DAEMON_RESIDENT");
  });

  it("should label itself apart from the daemon and run its own link", () => {
    // Given / When
    const plist = renderLaunchAgent(runnerSpec);

    // Then
    expect(plist).toContain(`<string>${RUNNER_AGENT_LABEL}</string>`);
    expect(plist).toContain("<string>/Users/x/.cerebrium/bin/runner.js</string>");
    expect(runnerLinkPath("/Users/x/.cerebrium")).toBe("/Users/x/.cerebrium/bin/runner.js");
    expect(runnerLinkPath("/Users/x/.cerebrium")).not.toBe(daemonLinkPath("/Users/x/.cerebrium"));
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

describe("Asking launchd which daemon it manages", () => {
  // Trimmed from real `launchctl print` output: the pid sits well down a long report, so
  // the parse has to survive everything above it.
  const PRINTED = `net.obrio.cerebrium.daemon = {
	active count = 1
	path = /Users/me/Library/LaunchAgents/net.obrio.cerebrium.daemon.plist
	state = running
	program = /opt/homebrew/bin/node
	arguments = {
		/opt/homebrew/bin/node
		/Users/me/.cerebrium/bin/daemon.js
	}
	default environment = {
		PATH => /usr/bin:/bin
	}
	pid = 45190
	immediate reason = speculative
	properties = keepalive | runatload
}`;

  it("should report the pid launchd supervises", () => {
    // Given / When / Then
    expect(launchdPid(() => PRINTED, 501)).toBe(45190);
  });

  it("should ask about a named agent when one is given, not always the daemon", () => {
    // Given
    const asked: string[] = [];

    // When
    launchdPid(
      (command) => {
        asked.push(command);

        return PRINTED;
      },
      501,
      RUNNER_AGENT_LABEL,
    );

    // Then
    expect(asked).toEqual([`launchctl print gui/501/${RUNNER_AGENT_LABEL}`]);
  });

  it("should ask about this user's own agent by label", () => {
    // Given
    const asked: string[] = [];

    // When
    launchdPid((command) => {
      asked.push(command);

      return PRINTED;
    }, 501);

    // Then — the label is the one the installer writes, not a second copy of the string.
    expect(asked).toEqual([`launchctl print gui/501/${LAUNCH_AGENT_LABEL}`]);
  });

  it("should report nothing when the agent is not installed", () => {
    // Given / When / Then — `launchctl print` exits non-zero and the call throws.
    expect(
      launchdPid(() => {
        throw new Error("Could not find service");
      }, 501),
    ).toBeNull();
  });

  it("should report nothing when launchd names no pid", () => {
    // Given / When / Then — a loaded but not running agent prints a report with no pid.
    expect(
      launchdPid(() => "net.obrio.cerebrium.daemon = {\n\tstate = not running\n}", 501),
    ).toBeNull();
  });

  it("should not mistake another number for the pid", () => {
    // Given — `active count` and `runs` are numbers that sit above the pid in the report.
    const noisy = "net.obrio.cerebrium.daemon = {\n\tactive count = 1\n\truns = 7\n\tpid = 900\n}";

    // When / Then
    expect(launchdPid(() => noisy, 501)).toBe(900);
  });
});
