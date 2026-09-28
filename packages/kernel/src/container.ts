import { container, instanceCachingFactory, type DependencyContainer } from "tsyringe";
import { CLOCK_TOKEN } from "@/domain/ports/clock";
import { CODE_PARSER_TOKEN } from "@/domain/ports/code-parser";
import { CONFIG_FILE_TOKEN, CONFIG_SOURCE_TOKEN, type ConfigSource } from "@/domain/ports/config";
import { CONSOLIDATION_PROVIDER_TOKEN } from "@/domain/ports/consolidation-provider";
import { CONSOLIDATION_REPORTER_TOKEN } from "@/domain/ports/consolidation-reporter";
import { EMBEDDING_PROVIDER_TOKEN } from "@/domain/ports/embedding-provider";
import { PROCESS_PROBE_TOKEN } from "@/domain/ports/process-probe";
import { USE_RECORDER_TOKEN } from "@/domain/ports/use-recorder";
import "@/application/use-cases/local";
import { CONSOLIDATION_REPO_TOKEN, NODES_REPO_TOKEN, STORAGE_TOKENS } from "@/domain/ports/storage";
import { WORKER_OPTIONS_TOKEN } from "@/application/workers";
import { registerPostgresRepositories } from "@/db/postgres";
import { registerSqliteRepositories } from "@/db/sqlite";
import { DB_TOKEN } from "@/db/sqlite/base";
import { openDatabase, openDatabaseReadonly } from "@/db/sqlite/database";
import { NoUseRecorder } from "@/db/sqlite/nodes";
import {
  ConsolidationConfig,
  DatabaseConfig,
  EmbeddingConfig,
  StorageConfig,
  STORE_BACKENDS,
} from "@/infrastructure/config";
import "@/infrastructure/config/sections";
import { InProcessCodeParser } from "@/code/unit-parser";
import { resolveRoles } from "@/consolidation/roles";
import { NoEmbeddingProvider } from "@/embeddings/worker-provider";
import { SystemClock } from "@/runtime/system-clock";
import { SystemProcessProbe } from "@/runtime/system-process-probe";
import { createConsolidator } from "@/consolidation";
import { createProvider } from "@/embeddings";
import { buildRemoteContainer, registerConfigSource } from "@/remote-container";

// Which process is being wired. A role selects *hosted behaviour* — whether this
// process drains the queue in large batches, whether it may write at all — never which
// tokens exist. Every role registers the same set, so a token cannot go missing in one
// host and be present in another.
export type HostRole = "server" | "daemon" | "cli" | "reader" | "runner";

// Which kernel backs the tokens. `local` resolves everything in-process against SQLite;
// `remote` resolves the same tokens against the daemon's socket and registers no database
// at all, so a host in that mode cannot reach the file even by accident.
export type KernelMode = "local" | "remote";

export interface ContainerOptions {
  role: HostRole;
  kernel?: KernelMode;
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
  clock: CLOCK_TOKEN,
  codeParser: CODE_PARSER_TOKEN,
  processProbe: PROCESS_PROBE_TOKEN,
  workerOptions: WORKER_OPTIONS_TOKEN,
  embeddingProvider: EMBEDDING_PROVIDER_TOKEN,
  consolidationProvider: CONSOLIDATION_PROVIDER_TOKEN,
  consolidationReporter: CONSOLIDATION_REPORTER_TOKEN,
  useRecorder: USE_RECORDER_TOKEN,
  ...STORAGE_TOKENS,
} as const;

export function buildContainer({
  role,
  source,
  into,
  kernel = "local",
}: ContainerOptions): DependencyContainer {
  const target = into ?? container;

  if (kernel === "remote") return buildRemoteContainer({ source, into: target });

  registerConfigSource(target, source);

  registerLocalKernel(role, target);

  return target;
}

// The local kernel: everything resolves in-process against the configured store — one
// SQLite file, or a Postgres database. A remote kernel registers these same tokens against
// a transport client instead.
//
// Registrations are lazy (`instanceCachingFactory`): a role that never resolves the
// embedding provider never constructs it, which is what makes registering the full set
// for every role free.
function registerLocalKernel(role: HostRole, target: DependencyContainer): void {
  // `reader` is a read pool worker: read-only so a use case that writes fails here rather
  // than racing the one writer.
  const readOnly = role === "cli" || role === "reader";

  if (target.resolve(StorageConfig).backend === STORE_BACKENDS.POSTGRES) {
    registerPostgresRepositories(target, { readOnly });
  } else {
    target.register(DB_TOKEN, {
      useFactory: instanceCachingFactory((c) => {
        const { path } = c.resolve(DatabaseConfig);

        return readOnly ? openDatabaseReadonly(path) : openDatabase(path);
      }),
    });
    registerSqliteRepositories(target);
  }

  target.registerSingleton(CLOCK_TOKEN, SystemClock);
  target.register(CODE_PARSER_TOKEN, { useValue: new InProcessCodeParser() });
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
      // A read-pool worker must never load a model: three of them each loading one cost a
      // measured +224MB for a single hybrid search. Whoever dispatches the read supplies
      // the query vector, so an embed call here is a bug and says so.
      if (role === "reader") return new NoEmbeddingProvider();

      const config = c.resolve(EmbeddingConfig);

      return createProvider(config.provider, config.model, config.cacheDir, {
        url: config.url,
        timeoutMs: config.timeoutMs,
        batchSize: config.batchSize,
      });
    }),
  });

  target.register(CONSOLIDATION_PROVIDER_TOKEN, {
    useFactory: instanceCachingFactory((c) => {
      const config = c.resolve(ConsolidationConfig);

      return createConsolidator(config.provider, {
        roles: resolveRoles(config, config.roles),
        cmd: config.command ?? undefined,
      });
    }),
  });

  target.register(CONSOLIDATION_REPORTER_TOKEN, {
    useToken: CONSOLIDATION_REPO_TOKEN,
  });

  target.register(USE_RECORDER_TOKEN, {
    useFactory: instanceCachingFactory((c) =>
      // `get` bumps use_count, which the read-only roles cannot do. They record nothing
      // and the caller that dispatched the read writes it — see CallPipeline.
      role === "cli" || role === "reader" ? new NoUseRecorder() : c.resolve(NODES_REPO_TOKEN),
    ),
  });
}
