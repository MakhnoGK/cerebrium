import { container, injectable } from "tsyringe";
import { Ctx } from "@/tools/context";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";
import { Repo } from "@/db/repo";
import { openDatabase } from "@/db/database";
import { createReranker } from "@/rerank";

@injectable()
export class Context implements Ctx {
  consolidator = createConsolidator();
  provider = createProvider();
  repo = new Repo(openDatabase());
  reranker = createReranker();
  workingSetBudget = Number(process.env.MEMORY_WORKING_SET_TOKENS) || 1500;

  now(): string {
    return new Date().toISOString();
  }
}

container.registerSingleton("Ctx", Context);
