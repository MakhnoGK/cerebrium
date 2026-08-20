#!/usr/bin/env node
import "reflect-metadata";
import { ProcessRegistryService } from "@/application/services";
import { EmbeddingWorker } from "@/application/workers";
import { isMainModule } from "@/runtime/is-main";
import { Server } from "@/presentation/mcp/server";
import { buildContainer } from "@/container";
import { DatabaseConfig, EmbeddingConfig } from "@/infrastructure/config";
import { ensureDaemon } from "./runtime/ensure-daemon";

async function main(): Promise<void> {
  const container = buildContainer({ role: "server" });

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

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("Cerebrium failed to start:", err);
    process.exit(1);
  });
}
