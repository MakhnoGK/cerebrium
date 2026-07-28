import "reflect-metadata";
import { container } from "tsyringe";
import { DB_TOKEN } from "../src/db/repositories/base";
import { openDatabase } from "../src/db/database";
import { EMBEDDING_PROVIDER_TOKEN } from "../src/embeddings";
import { LocalNullProvider } from "../src/embeddings/local-null";
import { RERANK_PROVIDER_TOKEN, createReranker } from "../src/rerank";
import { CONSOLIDATOR_TOKEN } from "../src/tools/services/consolidation.service";
import { createConsolidator } from "../src/consolidation";
import { CLOCK_TOKEN, SystemClock } from "../src/tools/services/clock.service";

container.register(DB_TOKEN, { useValue: openDatabase(":memory:") });
container.registerSingleton(CLOCK_TOKEN, SystemClock);
container.register(EMBEDDING_PROVIDER_TOKEN, { useValue: new LocalNullProvider() });
container.register(RERANK_PROVIDER_TOKEN, { useValue: createReranker("off") });
container.register(CONSOLIDATOR_TOKEN, { useValue: createConsolidator("manual") });
