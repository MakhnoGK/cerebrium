import { container, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { CONFIG_SOURCE_TOKEN, type ConfigSource } from "@/domain/ports/config";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { RERANK_PROVIDER_TOKEN } from "@/domain/ports/rerank-provider";
import { WORKER_OPTIONS_TOKEN } from "@/application/workers";
import { openDatabase, openDatabaseReadonly } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import {
  ConsolidationConfig,
  DatabaseConfig,
  EmbeddingConfig,
  EnvConfigSource,
  RerankConfig,
} from "@/infrastructure/config";
import "@/infrastructure/config/sections";
import { SystemClock } from "@/runtime/system-clock";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";
import { createReranker } from "@/rerank";

// Which process is being wired. A role selects *hosted behaviour* — whether this
// process drains the queue in large batches, whether it may write at all — never which
// tokens exist. Every role registers the same set, so a token cannot go missing in one
// host and be present in another.
export type HostRole = "server" | "daemon" | "cli";

export interface ContainerOptions {
  role: HostRole;
  // Pin configuration instead of reading the environment (tests, and later a config file).
  source?: ConfigSource;
}

// Every token the kernel registers, in one list, so a parity test can assert that no
// role is missing one.
export const KERNEL_TOKENS = [
  CONFIG_SOURCE_TOKEN,
  DB_TOKEN,
  CLOCK_TOKEN,
  WORKER_OPTIONS_TOKEN,
  EMBEDDING_PROVIDER_TOKEN,
  RERANK_PROVIDER_TOKEN,
  CONSOLIDATION_PROVIDER_TOKEN,
] as const;

export function buildContainer({ role, source }: ContainerOptions): DependencyContainer {
  container.register(CONFIG_SOURCE_TOKEN, { useValue: source ?? new EnvConfigSource() });

  registerLocalKernel(role);

  return container;
}

// The local kernel: everything resolves in-process against one SQLite file. A remote
// kernel would register these same tokens against a transport client and sit beside
// this function; nothing else would change.
//
// Registrations are lazy (`instanceCachingFactory`): a role that never resolves the
// embedding provider never constructs it, which is what makes registering the full set
// for every role free.
function registerLocalKernel(role: HostRole): void {
  container.register(DB_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const { path } = c.resolve(DatabaseConfig);

      return role === "cli" ? openDatabaseReadonly(path) : openDatabase(path);
    }),
  });

  container.registerSingleton(CLOCK_TOKEN, SystemClock);

  container.register(WORKER_OPTIONS_TOKEN, {
    // The daemon feeds the model in large batches; the server's in-process fallback
    // worker stays gentle on the shared DB.
    useFactory: instanceCachingFactory((c) =>
      role === "daemon" ? { batchSize: c.resolve(EmbeddingConfig).batchSize } : {},
    ),
  });

  container.register(EMBEDDING_PROVIDER_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const config = c.resolve(EmbeddingConfig);

      return createProvider(config.provider, config.model, config.cacheDir);
    }),
  });

  container.register(RERANK_PROVIDER_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const config = c.resolve(RerankConfig);

      return createReranker(config.provider, config.model, config.cacheDir);
    }),
  });

  container.register(CONSOLIDATION_PROVIDER_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const config = c.resolve(ConsolidationConfig);

      return createConsolidator(config.provider, {
        url: config.url,
        model: config.model,
        cmd: config.command ?? undefined,
        timeoutMs: config.timeoutMs,
      });
    }),
  });
}
