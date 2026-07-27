#!/usr/bin/env node

import "reflect-metadata";
import { container } from "tsyringe";
import { isMainModule } from "@/runtime/is-main";
import { Server } from "@/core/server";
import Database from "better-sqlite3";
import { DB_TOKEN } from "@/db/repositories/base";
import { openDatabase } from "@/db/database";
import { ensureDaemon } from "./runtime/ensure-daemon";
import { EmbeddingWorker } from "./embeddings/worker";
import { createProvider, EMBEDDING_PROVIDER_TOKEN, EmbeddingProvider } from "./embeddings";
import { ConsolidationProvider, createConsolidator } from "./consolidation";
import { CONSOLIDATOR_TOKEN } from "./tools/services/consolidation.service";

async function main(): Promise<void> {
  container.register<Database.Database>(DB_TOKEN, { useValue: openDatabase() });
  container.register<ConsolidationProvider>(CONSOLIDATOR_TOKEN, { useValue: createConsolidator() });
  container.register<EmbeddingProvider>(EMBEDDING_PROVIDER_TOKEN, { useValue: createProvider() });

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
