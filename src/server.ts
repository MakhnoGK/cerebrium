#!/usr/bin/env node
import "reflect-metadata";
import Database from "better-sqlite3";
import { container } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import {
  CONSOLIDATION_PROVIDER_TOKEN,
  type ConsolidationProvider,
} from "@/domain/ports/consolidation-provider";
import {
  EMBEDDING_PROVIDER_TOKEN,
  type EmbeddingProvider,
} from "@/domain/ports/embedding-provider";
import { RERANK_PROVIDER_TOKEN, type RerankProvider } from "@/domain/ports/rerank-provider";
import { EmbeddingWorker, WORKER_OPTIONS_TOKEN } from "@/application/workers";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { isMainModule } from "@/runtime/is-main";
import { SystemClock } from "@/runtime/system-clock";
import { Server } from "@/presentation/mcp/server";
import { createProvider } from "@/embeddings";
import { createReranker } from "@/rerank";
import { createConsolidator } from "./consolidation";
import { ensureDaemon } from "./runtime/ensure-daemon";

async function main(): Promise<void> {
  container.register<Database.Database>(DB_TOKEN, { useValue: openDatabase() });
  container.registerSingleton(CLOCK_TOKEN, SystemClock);
  container.register(WORKER_OPTIONS_TOKEN, { useValue: {} });
  container.register<ConsolidationProvider>(CONSOLIDATION_PROVIDER_TOKEN, {
    useValue: createConsolidator(),
  });
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
    console.error("Cerebrium failed to start:", err);
    process.exit(1);
  });
}
