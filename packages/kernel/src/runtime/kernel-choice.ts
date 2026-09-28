import { readFileSync } from "node:fs";
import { parseKernelTarget } from "@cerebrium/contracts/rpc";
import { rpcHandshake, RpcUnavailableError } from "@/runtime/rpc-client";
import type { KernelConfig } from "@/infrastructure/config";

export type KernelChoice =
  { kernel: "remote"; protocol: number } | { kernel: "local"; reason: string };

// How a host decides which kernel to use. The handshake is the whole test: a daemon that
// is not listening, or one speaking a protocol this build does not, means local.
//
// The budget is deliberately short. A stdio host is started by an agent that will give up
// on it, so being slow to start is as bad as failing.
export const HANDSHAKE_BUDGET_MS = 750;

// What a host waits instead when a live daemon owns the pidfile but has not answered yet.
// Measured over 1,280 handshakes against the live daemon: p50 1ms, p90 7ms, p99 66ms — and
// a window of tens of seconds where a consolidation stage held the main thread and nothing
// was answered at all. Degrading during one of those is far more expensive than the wait:
// a host on the local kernel opens a second writable handle to the same file and applies
// none of the principal policy, for the whole session. Silence from a daemon that is
// demonstrably alive means busy, not absent.
export const BUSY_BUDGET_MS = 30_000;

export async function chooseKernel(
  socketPath: string,
  timeoutMs = HANDSHAKE_BUDGET_MS,
  daemonIsAlive: () => boolean = () => false,
): Promise<KernelChoice> {
  const first = await attempt(socketPath, timeoutMs);

  if (first.kernel === "remote") return first;

  // Only a transport failure is worth waiting out. A protocol mismatch will still be a
  // mismatch in thirty seconds.
  if (!first.unavailable || !daemonIsAlive()) return first.choice;

  const second = await attempt(socketPath, BUSY_BUDGET_MS);

  if (second.kernel === "remote") return second;

  return {
    kernel: "local",
    reason: `daemon is alive but did not answer in ${String(BUSY_BUDGET_MS)}ms`,
  };
}

type Attempt =
  | { kernel: "remote"; protocol: number }
  | { kernel: "local"; unavailable: boolean; choice: KernelChoice };

async function attempt(socketPath: string, timeoutMs: number): Promise<Attempt> {
  try {
    return { kernel: "remote", protocol: await rpcHandshake({ socketPath, timeoutMs }) };
  } catch (err) {
    // Both paths end in a local kernel, but they are not the same event: an absent daemon
    // is ordinary, while a version mismatch means a resident daemon is serving an older
    // build and somebody should restart it.
    const unavailable = err instanceof RpcUnavailableError;

    return {
      kernel: "local",
      unavailable,
      choice: {
        kernel: "local",
        reason: unavailable
          ? "no daemon is listening"
          : `daemon unusable: ${(err as Error).message}`,
      },
    };
  }
}

export interface ExplicitKernel {
  url: string;
  token: string | null;
}

// A kernel named in config. When there is one, a host uses it and nothing else: no local
// daemon is looked for or started, and there is no local fallback.
export function explicitKernel(config: KernelConfig): ExplicitKernel | null {
  if (config.url === null) return null;

  const target = parseKernelTarget(config.url);

  if (target.kind === "tcp" && config.tokenFile === null) {
    throw new Error(`MEMORY_KERNEL_URL is ${config.url} but MEMORY_KERNEL_TOKEN_FILE is not set`);
  }

  return {
    url: config.url,
    token: config.tokenFile === null ? null : readToken(config.tokenFile),
  };
}

function readToken(path: string): string {
  let token: string;

  try {
    token = readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(`cannot read the kernel token file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (!token.length) throw new Error(`the kernel token file ${path} is empty`);

  return token;
}
