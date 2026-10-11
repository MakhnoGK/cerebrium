#!/usr/bin/env node
import "reflect-metadata";
import { buildContainer } from "@cerebrium/kernel/container";
import {
  DaemonConfig,
  DatabaseConfig,
  KernelConfig,
} from "@cerebrium/kernel/infrastructure/config";
import { Server } from "@cerebrium/kernel/presentation/mcp/server";
import { isDaemonAlive } from "@cerebrium/kernel/runtime/daemon-pid";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";
import {
  chooseKernel,
  explicitKernel,
  HANDSHAKE_BUDGET_MS,
} from "@cerebrium/kernel/runtime/kernel-choice";
import { serveHost } from "@plugin/src/serve-host";

// The host holds no database at all: it talks to the kernel named in config, or to the
// daemon on this machine's socket, and the daemon's pipeline checks the session and writes
// the audit row.
async function main(): Promise<void> {
  const probe = buildContainer({ role: "server", kernel: "remote" });
  const explicit = explicitKernel(probe.resolve(KernelConfig));

  if (explicit !== null) {
    await serveHost(explicit, probe);

    return;
  }

  const socketPath = probe.resolve(DaemonConfig).socketPath;
  const dbPath = probe.resolve(DatabaseConfig).path;
  const choice = await chooseKernel(socketPath, HANDSHAKE_BUDGET_MS, () => isDaemonAlive(dbPath));

  if (choice.kernel === "local") {
    throw new Error(
      `no Cerebrium daemon at ${socketPath} (${choice.reason}); set MEMORY_KERNEL_URL or start the daemon`,
    );
  }

  process.stderr.write(`kernel: daemon at ${socketPath} (protocol ${String(choice.protocol)})\n`);

  await probe.resolve(Server).connect();
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("Cerebrium failed to start:", err);
    process.exit(1);
  });
}
