import { container, injectable } from "tsyringe";
import { Ctx } from "@/tools/context";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";
import { createReranker } from "@/rerank";

@injectable()
export class Context implements Ctx {
  consolidator = createConsolidator();
  provider = createProvider();
  reranker = createReranker();
  workingSetBudget = Number(process.env.MEMORY_WORKING_SET_TOKENS) || 1500;

  now(): string {
    return new Date().toISOString();
  }
}

container.registerSingleton("Ctx", Context);
