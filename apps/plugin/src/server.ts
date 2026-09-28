#!/usr/bin/env node
import "reflect-metadata";
import type { DependencyContainer } from "tsyringe";
import { ProcessRegistryService } from "@cerebrium/kernel/application/services";
import { EmbeddingWorker } from "@cerebrium/kernel/application/workers";
import { buildContainer } from "@cerebrium/kernel/container";
import {
  DaemonConfig,
  DatabaseConfig,
  EmbeddingConfig,
  KernelConfig,
} from "@cerebrium/kernel/infrastructure/config";
import { Server } from "@cerebrium/kernel/presentation/mcp/server";
import { isDaemonAlive } from "@cerebrium/kernel/runtime/daemon-pid";
import { ensureDaemon } from "@cerebrium/kernel/runtime/ensure-daemon";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";
import {
  chooseKernel,
  explicitKernel,
  HANDSHAKE_BUDGET_MS,
} from "@cerebrium/kernel/runtime/kernel-choice";
import { pipelinedContainer } from "@cerebrium/kernel/runtime/pipelined-kernel";
import { rpcHandshake } from "@cerebrium/kernel/runtime/rpc-client";

// Talking to the daemon: the host holds no database at all, and the daemon's pipeline is
// what checks the session and writes the audit row.
async function serveRemote(container: DependencyContainer): Promise<void> {
  await container.resolve(Server).connect();
}

// No daemon reachable: the host degrades to resolving everything in-process, which is what
// it did before a transport existed. The tools are resolved from a scope whose call surface
// runs through the same pipeline the daemon uses, so the session check, the capability
// posture, the quota and the audit row apply here too.
async function serveLocal(container: DependencyContainer): Promise<void> {
  const scope = pipelinedContainer(container);

  const worker = container.resolve(EmbeddingWorker);
  const server = scope.resolve(Server);
  const registry = container.resolve(ProcessRegistryService);
  const registered = await registry.publish("server");

  // stdio hosts stop the server by closing the pipe or signalling it; either way the row
  // must go, and a sweep on the next publish is the backstop for a hard kill.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void registry.retire(registered).finally(() => process.exit(0));
    });
  }
  process.once("exit", () => {
    void registry.retire(registered);
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
      await worker.start();
    }
  } catch {
    await worker.start();
  }
}

async function main(): Promise<void> {
  // Built local first only to read the resolved socket path; the config tiers are the same
  // either way, and nothing that touches the database has been resolved yet.
  const probe = buildContainer({ role: "server" });
  const explicit = explicitKernel(probe.resolve(KernelConfig));

  if (explicit !== null) {
    // Reported, not required: every call names the URL when it cannot reach it.
    await rpcHandshake({
      socketPath: explicit.url,
      token: explicit.token,
      timeoutMs: HANDSHAKE_BUDGET_MS,
    })
      .then((protocol) => {
        process.stderr.write(`kernel: ${explicit.url} (protocol ${String(protocol)})\n`);
      })
      .catch((err: unknown) => {
        process.stderr.write(`kernel: ${explicit.url} unavailable: ${(err as Error).message}\n`);
      });

    await serveRemote(buildContainer({ role: "server", kernel: "remote" }));

    return;
  }

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
