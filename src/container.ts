import { container, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { CONFIG_FILE_TOKEN, CONFIG_SOURCE_TOKEN, type ConfigSource } from "@/domain/ports/config";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { CONSOLIDATION_REPORTER_TOKEN } from "@/domain/ports/consolidation-reporter";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { PROCESS_PROBE_TOKEN } from "@/domain/ports/process-probe";
import "@/application/use-cases/local";
import { WORKER_OPTIONS_TOKEN } from "@/application/workers";
import { openDatabase, openDatabaseReadonly } from "@/db/database";
import { DB_TOKEN } from "@/db/repositories/base";
import { ConsolidationRepo } from "@/db/repositories/consolidation";
import {
  ConsolidationConfig,
  DatabaseConfig,
  EmbeddingConfig,
  EnvConfigSource,
  FileConfigSource,
  LayeredConfigSource,
} from "@/infrastructure/config";
import "@/infrastructure/config/sections";
import { configFilePath } from "@/runtime/paths";
import { SystemClock } from "@/runtime/system-clock";
import { SystemProcessProbe } from "@/runtime/system-process-probe";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";

// Which process is being wired. A role selects *hosted behaviour* — whether this
// process drains the queue in large batches, whether it may write at all — never which
// tokens exist. Every role registers the same set, so a token cannot go missing in one
// host and be present in another.
export type HostRole = "server" | "daemon" | "cli" | "reader";

export interface ContainerOptions {
  role: HostRole;
  // Pin configuration instead of resolving the tiers below (tests, eval scripts).
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
  configFile: CONFIG_FILE_TOKEN,
  database: DB_TOKEN,
  clock: CLOCK_TOKEN,
  processProbe: PROCESS_PROBE_TOKEN,
  workerOptions: WORKER_OPTIONS_TOKEN,
  embeddingProvider: EMBEDDING_PROVIDER_TOKEN,
  consolidationProvider: CONSOLIDATION_PROVIDER_TOKEN,
  consolidationReporter: CONSOLIDATION_REPORTER_TOKEN,
} as const;

export function buildContainer({ role, source, into }: ContainerOptions): DependencyContainer {
  const target = into ?? container;

  registerConfigSource(target, source);

  registerLocalKernel(role, target);

  return target;
}

// Tiers: defaults <- config.json <- environment. Every host resolves them here and only
// here, so spawn order can no longer decide what a process is configured with — the
// daemon's posture used to depend on whether the GUI or Claude Code started it first.
function registerConfigSource(target: DependencyContainer, pinned?: ConfigSource): void {
  if (pinned) {
    target.register(CONFIG_SOURCE_TOKEN, { useValue: pinned });
    // A factory, not `useValue: null`: tsyringe tests `useValue != undefined`, so a null
    // value provider falls through and it tries to construct the token instead.
    target.register(CONFIG_FILE_TOKEN, { useFactory: () => null });

    return;
  }

  const file = new FileConfigSource(configFilePath());

  target.register(CONFIG_SOURCE_TOKEN, {
    useValue: new LayeredConfigSource(new EnvConfigSource(), file),
  });
  target.register(CONFIG_FILE_TOKEN, { useValue: file.report() });
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

      // `reader` is a read pool worker: read-only so a use case that writes fails here
      // rather than racing the one writer.
      return role === "cli" || role === "reader" ? openDatabaseReadonly(path) : openDatabase(path);
    }),
  });

  target.registerSingleton(CLOCK_TOKEN, SystemClock);
  target.registerSingleton(PROCESS_PROBE_TOKEN, SystemProcessProbe);

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
