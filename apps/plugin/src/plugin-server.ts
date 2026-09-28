#!/usr/bin/env node
import "reflect-metadata";
import { INDEX_CODE } from "@cerebrium/kernel/application/use-cases";
import { KernelConfig } from "@cerebrium/kernel/infrastructure/config";
import { buildRemoteContainer } from "@cerebrium/kernel/remote-container";
import { isMainModule } from "@cerebrium/kernel/runtime/is-main";
import { explicitKernel } from "@cerebrium/kernel/runtime/kernel-choice";
import { ClientIndexCode } from "@plugin/src/code/client-index-code";
import { codeContextOf } from "@plugin/src/code/context";
import { serveHost } from "@plugin/src/serve-host";

// cerebrium-plugin: the MCP server of a machine whose memory lives on a Cerebrium host.
// It opens no store, and never looks for, starts or falls back to a local daemon.
async function main(): Promise<void> {
  const container = buildRemoteContainer({ requireUrl: true, codeContext: codeContextOf() });

  container.register(INDEX_CODE, { useValue: new ClientIndexCode(container) });

  const kernel = explicitKernel(container.resolve(KernelConfig))!;

  await serveHost(kernel, container);
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `Cerebrium failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
