#!/usr/bin/env node
import "reflect-metadata";
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
