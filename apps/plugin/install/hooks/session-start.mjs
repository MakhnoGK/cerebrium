// The session-start nudge, in each host's own hook output contract. One script for all
// three, so the reminder has a single source: edit it here, no host needs re-installing.
//
//   node session-start.mjs --host claude|codex        -> SessionStart additionalContext
//   node session-start.mjs --host antigravity         -> PreInvocation ephemeralMessage

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
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function invocationNum(raw) {
  try {
    return Number(JSON.parse(raw || "{}").invocationNum ?? 0);
  } catch {
    return 0;
  }
}

const host = hostArg(process.argv.slice(2));

if (host === "antigravity") {
  // PreInvocation fires before every model call; the reminder belongs on the first one.
  const invocation = invocationNum(await readStdin());
  const payload = invocation > 0 ? {} : { injectSteps: [{ ephemeralMessage: REMINDER }] };
  process.stdout.write(JSON.stringify(payload));
} else {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: REMINDER },
    }),
  );
}
