import type { DependencyContainer } from "tsyringe";
import { STATS_SNAPSHOT, type StatsSnapshot } from "@/application/use-cases";
import { PROTOCOL_VERSION } from "@/core/rpc";
import type { RpcMethod } from "@/presentation/rpc/server";

export interface DaemonIdentity {
  pid: number;
  // Reported rather than awaited: `status` has to answer while the model is still
  // loading, and after a load that failed outright.
  model: () => { state: string; ms: number | null; error?: string } | null;
}

export function createDaemonMethods(
  container: DependencyContainer,
  identity: DaemonIdentity,
): Record<string, RpcMethod> {
  return {
    // The version handshake. A client calls this before anything else and refuses a
    // protocol it does not speak, so a rebuild against a still-running resident daemon
    // reports the mismatch instead of failing later as an unknown method.
    initialize: () => Promise.resolve({ protocol: PROTOCOL_VERSION, pid: identity.pid }),

    status: async () => {
      const snapshot = await container.resolve<StatsSnapshot>(STATS_SNAPSHOT).invoke({});

      return { ...snapshot, daemon: { ...identity.model(), pid: identity.pid } };
    },
  };
}
