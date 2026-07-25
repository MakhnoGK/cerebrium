#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isMainModule } from "@/runtime/is-main";
import type Database from "better-sqlite3";
import { openDatabase } from "@/db/database";
import { Repo } from "@/db/repo";
import { nowIso } from "@/core/ids";
import { createProvider } from "@/embeddings";
import { createReranker } from "@/rerank";
import { createConsolidator } from "@/consolidation";
import { EmbeddingWorker } from "@/embeddings/worker";
import { ensureDaemon } from "@/runtime/ensure-daemon";
import type { Ctx } from "@/tools/context";
import { TOOLS } from "@/tools";

export function buildCtx(db: Database.Database): Ctx {
  const budget = Number(process.env.MEMORY_WORKING_SET_TOKENS) || 1500;

  return {
    repo: new Repo(db),
    now: nowIso,
    workingSetBudget: budget,
    provider: createProvider(),
    reranker: createReranker(),
    consolidator: createConsolidator(),
  };
}

export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "cerebrium", version: "0.1.0" });

  TOOLS.forEach((tool) => {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      (args) => tool.callback(ctx, args),
    );
  });

  return server;
}

async function main(): Promise<void> {
  const db = openDatabase();
  const ctx = buildCtx(db);
  const server = createServer(ctx);
  // The embedding drain runs in a detached daemon that outlives this session.
  // Only fall back to an in-process worker if we can't get a daemon up — the
  // worker_lease keeps the two from double-writing if both ever run.
  try {
    if (ensureDaemon() === "skipped") {
      new EmbeddingWorker(ctx.repo, ctx.provider, ctx.now).start();
    }
  } catch {
    new EmbeddingWorker(ctx.repo, ctx.provider, ctx.now).start();
  }
  await server.connect(new StdioServerTransport());
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("cerebrium failed to start:", err);
    process.exit(1);
  });
}
