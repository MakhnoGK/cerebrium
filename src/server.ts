#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isMainModule } from "@/runtime/is-main";
import type { z } from "zod";
import type Database from "better-sqlite3";
import { openDatabase } from "@/db/database";
import { Repo } from "@/db/repo";
import { nowIso } from "@/core/ids";
import { createProvider } from "@/embeddings/index";
import { createReranker } from "@/rerank/index";
import { createConsolidator } from "@/consolidation/index";
import { EmbeddingWorker } from "@/embeddings/worker";
import { ensureDaemon } from "@/runtime/ensure-daemon";
import type { Ctx } from "@/tools/context";

import {
  checkpoint,
  code_index,
  code_lookup,
  consolidate_apply,
  consolidate_suggest,
  get,
  invalidate,
  link,
  mirror_status,
  mirror_upsert,
  search,
  session_start,
  source_register,
  stats,
  update,
  write,
} from "@/tools";

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

const ok = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
});
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: (err as Error).message }],
  isError: true as const,
});

export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "cerebrium", version: "0.1.0" });
  const add = <S extends z.ZodRawShape>(
    name: string,
    mod: {
      schema: S;
      description: string;
      handler: (ctx: Ctx, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
    },
  ) => {
    // ToolCallback<S> is a conditional type that won't unify with a generic S; cast through unknown.
    const cb = (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await mod.handler(ctx, args));
      } catch (err) {
        return fail(err);
      }
    }) as unknown as ToolCallback<S>;
    return server.registerTool(name, { description: mod.description, inputSchema: mod.schema }, cb);
  };

  add("session_start", session_start);
  add("search", search);
  add("get", get);
  add("write", write);
  add("update", update);
  add("invalidate", invalidate);
  add("checkpoint", checkpoint);
  add("link", link);
  add("code_index", code_index);
  add("code_lookup", code_lookup);
  add("source_register", source_register);
  add("mirror_upsert", mirror_upsert);
  add("mirror_status", mirror_status);
  add("consolidate_suggest", consolidate_suggest);
  add("consolidate_apply", consolidate_apply);
  add("stats", stats);
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
