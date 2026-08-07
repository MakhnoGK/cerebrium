import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hookScript, serverPath, type HostId, type PlanInput } from "@scripts/agent-hosts";

// Proves the install by exercising it, because a config file that mentions Cerebrium is
// not evidence that a host can call it. The server smoke runs against a throwaway store
// with the offline provider: it answers "does this bundle boot and inject", never
// "what is in the real memory", and it writes nothing the user keeps.

export interface VerifyResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface RpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agent-setup", version: "1" },
  },
};

const SESSION_START = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "session_start", arguments: {} },
};

const TOOLS_LIST = { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} };

export function parseRpcResponses(buffer: string): RpcResponse[] {
  return buffer
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RpcResponse];
      } catch {
        return [];
      }
    });
}

/** The nearest existing ancestor decides: the server creates the rest on first use. */
export function storeWritable(dbPath: string): boolean {
  let dir = dirname(dbPath);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function bundle(input: PlanInput): VerifyResult {
  const path = serverPath(input.repoRoot);
  return {
    name: "bundle",
    ok: existsSync(path),
    detail: existsSync(path) ? path : `${path} is missing — run npm run build`,
  };
}

function store(input: PlanInput): VerifyResult {
  const db = input.env.MEMORY_DB_PATH ?? "";
  const ok = db !== "" && storeWritable(db);
  return {
    name: "store",
    ok,
    detail: ok ? `${db} is writable` : `cannot write to ${db || "(no MEMORY_DB_PATH)"}`,
  };
}

async function server(input: PlanInput): Promise<VerifyResult> {
  const path = serverPath(input.repoRoot);
  if (!existsSync(path)) {
    return { name: "server", ok: false, detail: "skipped — no bundle to run" };
  }
  const scratch = mkdtempSync(join(tmpdir(), "cerebrium-verify-"));
  try {
    const out = await speak(path, {
      MEMORY_DB_PATH: join(scratch, "verify.db"),
      MEMORY_EMBED_PROVIDER: "local-null",
    });
    const responses = parseRpcResponses(out);
    const call = responses.find((r) => r.id === 2);
    const list = responses.find((r) => r.id === 3);
    const tools = Array.isArray(list?.result?.tools) ? list.result.tools.length : 0;
    const failed = call === undefined || call.error !== undefined;
    return {
      name: "server",
      ok: !failed && tools > 0,
      detail: failed
        ? `session_start failed: ${call?.error?.message ?? "no response"}`
        : `session_start answered; ${tools} tools exposed`,
    };
  } catch (err) {
    return { name: "server", ok: false, detail: `could not run the server: ${String(err)}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function speak(path: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out after 30s"));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const seen = parseRpcResponses(out);
      if (seen.some((r) => r.id === 2) && seen.some((r) => r.id === 3)) {
        clearTimeout(timer);
        child.kill();
        resolve(out);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });

    for (const message of [INITIALIZE, SESSION_START, TOOLS_LIST]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

async function hook(input: PlanInput, host: HostId): Promise<VerifyResult> {
  const script = hookScript(input.repoRoot);
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("node", [script, "--host", host], { stdio: ["pipe", "pipe", "ignore"] });
      let text = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (text += chunk));
      child.on("error", reject);
      child.on("close", () => {
        resolve(text);
      });
      child.stdin.end(JSON.stringify({ invocationNum: 1 }));
    });
    JSON.parse(out);
    return {
      name: `hook (${host})`,
      ok: out.includes("session_start"),
      detail: "emits a reminder",
    };
  } catch (err) {
    return { name: `hook (${host})`, ok: false, detail: `hook script failed: ${String(err)}` };
  }
}

export async function verify(input: PlanInput, hosts: readonly HostId[]): Promise<VerifyResult[]> {
  const results = [bundle(input), store(input), await server(input)];
  for (const host of hosts) results.push(await hook(input, host));
  return results;
}
