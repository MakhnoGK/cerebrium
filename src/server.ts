#!/usr/bin/env node

import "reflect-metadata";
import { container } from "tsyringe";
import { isMainModule } from "@/runtime/is-main";
import { Server } from "@/core/server";
import Database from "better-sqlite3";
import { DB_TOKEN } from "@/db/repositories/base";
import { openDatabase } from "@/db/database";

async function main(): Promise<void> {
  container.register<Database.Database>(DB_TOKEN, { useValue: openDatabase() });

  const server = container.resolve(Server);
  await server.connect();

  // The embedding drain runs in a detached daemon that outlives this session.
  // Only fall back to an in-process worker if we can't get a daemon up — the
  // worker_lease keeps the two from double-writing if both ever run.
  // try {
  //   if (ensureDaemon() === "skipped") {
  //     new EmbeddingWorker(ctx.repo, ctx.provider, ctx.now).start();
  //   }
  // } catch {
  //   new EmbeddingWorker(ctx.repo, ctx.provider, ctx.now).start();
  // }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("cerebrium failed to start:", err);
    process.exit(1);
  });
}
