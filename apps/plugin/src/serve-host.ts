import type { DependencyContainer } from "tsyringe";
import { Server } from "@cerebrium/kernel/presentation/mcp/server";
import { HANDSHAKE_BUDGET_MS, type ExplicitKernel } from "@cerebrium/kernel/runtime/kernel-choice";
import { rpcHandshake } from "@cerebrium/kernel/runtime/rpc-client";

// Serves MCP against a kernel named in config. The handshake is reported, not required:
// every call names the URL when it cannot reach it.
export async function serveHost(
  kernel: ExplicitKernel,
  container: DependencyContainer,
): Promise<void> {
  await rpcHandshake({
    socketPath: kernel.url,
    token: kernel.token,
    timeoutMs: HANDSHAKE_BUDGET_MS,
  })
    .then((protocol) => {
      process.stderr.write(`kernel: ${kernel.url} (protocol ${String(protocol)})\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`kernel: ${kernel.url} unavailable: ${(err as Error).message}\n`);
    });

  await container.resolve(Server).connect();
}
