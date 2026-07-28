import "reflect-metadata";
import { container } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { openDatabase } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { LocalNullProvider } from "@/embeddings/local-null";
import { WORKER_OPTIONS_TOKEN } from "@/embeddings/worker";
import { SystemClock } from "@/runtime/system-clock";
import { CONSOLIDATOR_TOKEN } from "@/tools/services/consolidation.service";
import { createConsolidator } from "@/consolidation";
import { EMBEDDING_PROVIDER_TOKEN } from "@/embeddings";
import { createReranker, RERANK_PROVIDER_TOKEN } from "@/rerank";

container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
container.registerSingleton(CLOCK_TOKEN, SystemClock);
container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });
container.register(RERANK_PROVIDER_TOKEN, { useValue: createReranker("off") });
container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator("manual") });
container.register(WORKER_OPTIONS_TOKEN, { useValue: {} });
