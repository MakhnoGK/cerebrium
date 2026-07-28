#!/usr/bin/env node
import "reflect-metadata";
import Database from "better-sqlite3";
import { container } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { isMainModule } from "@/runtime/is-main";
import { SystemClock } from "@/runtime/system-clock";
import { Server } from "@/core/server";
import { createConsolidator, type ConsolidationProvider } from "./consolidation";
import { createProvider, EMBEDDING_PROVIDER_TOKEN, type EmbeddingProvider } from "./embeddings";
import { EmbeddingWorker, WORKER_OPTIONS_TOKEN } from "./embeddings/worker";
import { createReranker, RERANK_PROVIDER_TOKEN, type RerankProvider } from "./rerank";
import { ensureDaemon } from "./runtime/ensure-daemon";
import { CONSOLIDATOR_TOKEN } from "./tools/services/consolidation.service";

async function main(): Promise<void> {
  container.register<Database.Database>(DB_TOKEN, { useValue: openDatabase() });
  container.registerSingleton(CLOCK_TOKEN, SystemClock);
  container.register(WORKER_OPTIONS_TOKEN, { useValue: {} });
  container.register<ConsolidationProvider>(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });
  container.register<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider() });
  container.register<RerankProvider>(RERANK_PROVIDER_TOKEN, { useValue: createReranker() });

  const worker = container.resolve(EmbeddingWorker);
  const server = container.resolve(Server);

  await server.connect();

  // The embedding drain runs in a detached daemon that outlives this session.
  // Only fall back to an in-process worker if we can't get a daemon up — the
  // worker_lease keeps the two from double-writing if both ever run.
  try {
    if (ensureDaemon() === "skipped") {
      worker.start();
    }
  } catch {
    worker.start();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("cerebrium failed to start:", err);
    process.exit(1);
  });
}
