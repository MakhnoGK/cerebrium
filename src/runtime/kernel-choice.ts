import { rpcHandshake, RpcUnavailableError } from "@/runtime/rpc-client";

export type KernelChoice =
  { kernel: "remote"; protocol: number } | { kernel: "local"; reason: string };

// How a host decides which kernel to use. The handshake is the whole test: a daemon that
// is not listening, or one speaking a protocol this build does not, means local.
//
// The budget is deliberately short. A stdio host is started by an agent that will give up
// on it, so being slow to start is as bad as failing — degrading to a local kernel is
// always better than making the client wait.
export const HANDSHAKE_BUDGET_MS = 750;

export async function chooseKernel(
  socketPath: string,
  timeoutMs = HANDSHAKE_BUDGET_MS,
): Promise<KernelChoice> {
  try {
    const protocol = await rpcHandshake({ socketPath, timeoutMs });

    return { kernel: "remote", protocol };
  } catch (err) {
    // Both paths end in a local kernel, but they are not the same event: an absent daemon
    // is ordinary, while a version mismatch means a resident daemon is serving an older
    // build and somebody should restart it.
    return {
      kernel: "local",
      reason:
        err instanceof RpcUnavailableError
          ? "no daemon is listening"
          : `daemon unusable: ${(err as Error).message}`,
    };
  }
}
