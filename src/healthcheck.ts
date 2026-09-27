#!/usr/bin/env node
import "reflect-metadata";
import { isMainModule } from "@/runtime/is-main";
import { closeRpcConnections, rpcCall } from "@/runtime/rpc-client";
import { PROTOCOL_VERSION } from "@/core/rpc";
import { buildContainer } from "@/container";
import { DaemonConfig } from "@/infrastructure/config";

const TIMEOUT_MS = 5_000;

// What stands between the daemon and healthy, or null when nothing does.
export function healthProblem(report: unknown): string | null {
  if (typeof report !== "object" || report === null) return "no health report";

  const { protocol, model } = report as {
    protocol?: unknown;
    model?: { state?: unknown; error?: unknown } | null;
  };

  if (protocol !== PROTOCOL_VERSION) {
    return `daemon speaks protocol ${String(protocol)}, this build speaks ${String(PROTOCOL_VERSION)}`;
  }

  if (model === undefined || model === null) return "model still loading";

  if (model.state !== "ready") {
    const reason = typeof model.error === "string" ? `: ${model.error}` : "";

    return `model ${String(model.state)}${reason}`;
  }

  return null;
}

export async function checkHealth(socketPath: string): Promise<string | null> {
  try {
    return healthProblem(await rpcCall({ socketPath, timeoutMs: TIMEOUT_MS }, "health"));
  } catch (err) {
    return (err as Error).message;
  } finally {
    closeRpcConnections();
  }
}

async function main(): Promise<number> {
  const socketPath = buildContainer({ role: "cli" }).resolve(DaemonConfig).socketPath;
  const problem = await checkHealth(socketPath);

  process.stdout.write(problem === null ? "healthy\n" : `unhealthy: ${problem}\n`);

  return problem === null ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  void main().then((code) => process.exit(code));
}
