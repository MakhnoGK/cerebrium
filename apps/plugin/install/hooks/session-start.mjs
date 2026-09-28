// The session-start nudge, in each host's own hook output contract. One script for all
// three, so the reminder has a single source: edit it here, no host needs re-installing.
//
//   node session-start.mjs --host claude|codex        -> SessionStart additionalContext
//   node session-start.mjs --host antigravity         -> PreInvocation ephemeralMessage
//
// When the session opens inside a checkout listed in ~/.cerebrium/plugin-index.json, it
// also starts a background index of that checkout on the Cerebrium host.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

const REMINDER =
  "Cerebrium is this machine's durable cross-session memory (MCP server `cerebrium`). " +
  "Call `session_start` before any other memory tool and read its working set to orient; " +
  "pass the returned session_id to every later call; search memory before answering from " +
  "scratch and before writing. In indexed repos, use `code_lookup` or symbol search before " +
  "scanning files. Attach durable writes to an exact `parent_node_id` and link them to " +
  "relevant memories or symbols. Call `checkpoint` before ending a substantial work block.";

function hostArg(argv) {
  const i = argv.indexOf("--host");
  return i === -1 ? "" : (argv[i + 1] ?? "");
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    // A host that leaves stdin open must not stall the session.
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(data);
    }, 1000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

function invocationNum(raw) {
  try {
    return Number(JSON.parse(raw || "{}").invocationNum ?? 0);
  } catch {
    return 0;
  }
}

function sessionCwd(raw) {
  try {
    const cwd = JSON.parse(raw || "{}").cwd;
    return typeof cwd === "string" && cwd.length ? cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

// Never fails the hook: indexing is a side effect the reminder does not wait for.
function indexOnHost(cwd) {
  try {
    const home = process.env.CEREBRIUM_HOME || join(homedir(), ".cerebrium");
    const config = JSON.parse(readFileSync(join(home, "plugin-index.json"), "utf8"));
    const repos = Array.isArray(config.repos) ? config.repos : [];
    const repo = repos.find((r) => cwd === r || cwd.startsWith(`${r}/`));

    if (!repo || typeof config.bundle !== "string" || !existsSync(config.bundle)) return;

    spawn(process.execPath, [config.bundle, repo, "--detach", "--quiet", "--min-interval", "60"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // no config, unreadable config, or no node to spawn
  }
}

const host = hostArg(process.argv.slice(2));
const input = await readStdin();

if (host !== "antigravity" || invocationNum(input) === 0) indexOnHost(sessionCwd(input));

if (host === "antigravity") {
  // PreInvocation fires before every model call; the reminder belongs on the first one.
  const invocation = invocationNum(input);
  const payload = invocation > 0 ? {} : { injectSteps: [{ ephemeralMessage: REMINDER }] };
  process.stdout.write(JSON.stringify(payload));
} else {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: REMINDER },
    }),
  );
}
