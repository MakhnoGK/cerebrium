import { container, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { CONFIG_SOURCE_TOKEN, type ConfigSource } from "@/domain/ports/config";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { CONSOLIDATION_REPORTER_TOKEN } from "@/domain/ports/consolidation-reporter";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { WORKER_OPTIONS_TOKEN } from "@/application/workers";
import { openDatabase, openDatabaseReadonly } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { ConsolidationRepo } from "@/db/repositories/consolidation";
import {
  ConsolidationConfig,
  DatabaseConfig,
  EmbeddingConfig,
  EnvConfigSource,
} from "@/infrastructure/config";
import "@/infrastructure/config/sections";
import { SystemClock } from "@/runtime/system-clock";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";

// Which process is being wired. A role selects *hosted behaviour* — whether this
// process drains the queue in large batches, whether it may write at all — never which
// tokens exist. Every role registers the same set, so a token cannot go missing in one
// host and be present in another.
export type HostRole = "server" | "daemon" | "cli";

export interface ContainerOptions {
  role: HostRole;
  // Pin configuration instead of reading the environment (tests, and later a config file).
  source?: ConfigSource;
  // Where to register. Defaults to the global container the `@tool()` and `@configSection()`
  // decorators populate at import time. A child container isolates one build from another,
  // which is how the parity test inspects a role's own registrations.
  into?: DependencyContainer;
}

// Every token the kernel registers, named, so a parity test can assert that no role is
// missing one and say which.
export const KERNEL_TOKENS = {
  configSource: CONFIG_SOURCE_TOKEN,
  database: DB_TOKEN,
  clock: CLOCK_TOKEN,
  workerOptions: WORKER_OPTIONS_TOKEN,
  embeddingProvider: EMBEDDING_PROVIDER_TOKEN,
  consolidationProvider: CONSOLIDATION_PROVIDER_TOKEN,
  consolidationReporter: CONSOLIDATION_REPORTER_TOKEN,
} as const;

export function buildContainer({ role, source, into }: ContainerOptions): DependencyContainer {
  const target = into ?? container;

  target.register(CONFIG_SOURCE_TOKEN, { useValue: source ?? new EnvConfigSource() });

  registerLocalKernel(role, target);

  return target;
}

// The local kernel: everything resolves in-process against one SQLite file. A remote
// kernel would register these same tokens against a transport client and sit beside
// this function; nothing else would change.
//
// Registrations are lazy (`instanceCachingFactory`): a role that never resolves the
// embedding provider never constructs it, which is what makes registering the full set
// for every role free.
function registerLocalKernel(role: HostRole, target: DependencyContainer): void {
  target.register(DB_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const { path } = c.resolve(DatabaseConfig);

      return role === "cli" ? openDatabaseReadonly(path) : openDatabase(path);
    }),
  });

  target.registerSingleton(CLOCK_TOKEN, SystemClock);

  target.register(WORKER_OPTIONS_TOKEN, {
    // The daemon feeds the model in large batches; the server's in-process fallback
    // worker stays gentle on the shared DB.
    useFactory: instanceCachingFactory((c) =>
      role === "daemon" ? { batchSize: c.resolve(EmbeddingConfig).batchSize } : {},
    ),
  });

  target.register(EMBEDDING_PROVIDER_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const config = c.resolve(EmbeddingConfig);

      return createProvider(config.provider, config.model, config.cacheDir);
    }),
  });

  target.register(CONSOLIDATION_PROVIDER_TOKEN, {
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

  target.register(CONSOLIDATION_REPORTER_TOKEN, {
    useToken: ConsolidationRepo,
  });
}
