#!/usr/bin/env node
import "reflect-metadata";
import type { DependencyContainer } from "tsyringe";
import { ProcessRegistryService } from "@/application/services";
import { EmbeddingWorker } from "@/application/workers";
import { isDaemonAlive } from "@/runtime/daemon-pid";
import { isMainModule } from "@/runtime/is-main";
import { chooseKernel, HANDSHAKE_BUDGET_MS } from "@/runtime/kernel-choice";
import {
  GuardedToolWrapper,
  PassThroughToolWrapper,
  TOOL_WRAPPER,
} from "@/presentation/mcp/adapters";
import { Server } from "@/presentation/mcp/server";
import { buildContainer } from "@/container";
import { DaemonConfig, DatabaseConfig, EmbeddingConfig } from "@/infrastructure/config";
import { ensureDaemon } from "./runtime/ensure-daemon";

// Talking to the daemon: the host holds no database at all. It also does not guard or audit
// — the daemon's pipeline does both, and doing it here too would check the session twice and
// write two `events` rows per call.
async function serveRemote(container: DependencyContainer): Promise<void> {
  container.register(TOOL_WRAPPER, { useValue: new PassThroughToolWrapper() });

  await container.resolve(Server).connect();
}

// No daemon reachable: the host degrades to resolving everything in-process, which is what
// it did before a transport existed. It guards and audits itself, because nothing else will.
async function serveLocal(container: DependencyContainer): Promise<void> {
  container.register(TOOL_WRAPPER, { useToken: GuardedToolWrapper });

  const worker = container.resolve(EmbeddingWorker);
  const server = container.resolve(Server);
  const registry = container.resolve(ProcessRegistryService);
  const registered = registry.publish("server");

  // stdio hosts stop the server by closing the pipe or signalling it; either way the row
  // must go, and a sweep on the next publish is the backstop for a hard kill.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      registry.retire(registered);
      process.exit(0);
    });
  }
  process.once("exit", () => {
    registry.retire(registered);
  });

  await server.connect();

  // The embedding drain runs in a detached daemon that outlives this session.
  // Only fall back to an in-process worker if we can't get a daemon up — the
  // worker_lease keeps the two from double-writing if both ever run.
  const daemon = {
    dbPath: container.resolve(DatabaseConfig).path,
    embedProvider: container.resolve(EmbeddingConfig).provider,
  };

  try {
    if (ensureDaemon(daemon) === "skipped") {
      worker.start();
    }
  } catch {
    worker.start();
  }
}

async function main(): Promise<void> {
  // Built local first only to read the resolved socket path; the config tiers are the same
  // either way, and nothing that touches the database has been resolved yet.
  const probe = buildContainer({ role: "server" });
  const socketPath = probe.resolve(DaemonConfig).socketPath;
  const dbPath = probe.resolve(DatabaseConfig).path;
  const choice = await chooseKernel(socketPath, HANDSHAKE_BUDGET_MS, () => isDaemonAlive(dbPath));

  if (choice.kernel === "remote") {
    process.stderr.write(`kernel: daemon at ${socketPath} (protocol ${String(choice.protocol)})\n`);

    await serveRemote(buildContainer({ role: "server", kernel: "remote" }));

    return;
  }

  process.stderr.write(`kernel: local (${choice.reason})\n`);

  await serveLocal(probe);
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("Cerebrium failed to start:", err);
    process.exit(1);
  });
}
