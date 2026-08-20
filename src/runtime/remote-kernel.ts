import type { DependencyContainer, InjectionToken } from "tsyringe";
import { CALL_SURFACE, isRetryable, type CallName, type UseCase } from "@/application/use-cases";
import { ClientIdentity } from "@/runtime/client-identity";
import { rpcCall, RpcUnavailableError } from "@/runtime/rpc-client";
import type { RpcMeta } from "@/core/rpc";

// The remote kernel. It registers the same use-case tokens as the local one, against a
// socket client instead of a database — which is the whole payoff of addressing use cases
// by token and interface rather than by concrete class.
//
// What it deliberately does NOT register is the kernel itself: no database handle, no
// providers, no repositories. A host in this mode cannot reach the file even by accident,
// and resolving a repository throws instead of quietly opening a second connection to a
// database another process is writing.

// A raw `connect ENOENT` tells an agent nothing it can act on. What it needs to know is
// whether repeating the call is safe, and that differs by call: a read can be retried
// freely, while a write that may already have been applied must not be.
export class DaemonUnreachableError extends Error {
  constructor(
    readonly call: CallName,
    socketPath: string,
    readonly cause: string,
  ) {
    super(
      `the memory daemon at ${socketPath} did not answer ${call} (${cause}). ` +
        (isRetryable(call)
          ? "This is a read: retry it. If it keeps failing, check `cerebrium-service status`."
          : "This is a write and it may or may not have been applied — check before repeating it, " +
            "because repeating it could duplicate the change. Then check `cerebrium-service status`."),
    );
    this.name = "DaemonUnreachableError";
  }
}

export interface RemoteKernelOptions {
  socketPath: string;
  timeoutMs?: number;
}

class RemoteUseCase implements UseCase<unknown, unknown> {
  constructor(
    private readonly name: CallName,
    private readonly options: RemoteKernelOptions,
    // Read per call, not per registration: the MCP handshake that names the client happens
    // after the container is built.
    private readonly identity: () => RpcMeta,
  ) {}

  async invoke(args: unknown): Promise<unknown> {
    try {
      return await rpcCall(
        {
          socketPath: this.options.socketPath,
          ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
        },
        this.name,
        // Arguments cross as JSON, so they must already be plain data. They are: the seam
        // was defined that way precisely so a remote implementation could substitute here.
        (args ?? {}) as Record<string, unknown>,
        this.identity(),
      );
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        throw new DaemonUnreachableError(this.name, this.options.socketPath, err.message);
      }

      throw err;
    }
  }
}

export function registerRemoteKernel(
  target: DependencyContainer,
  options: RemoteKernelOptions,
): void {
  // Who this host is, as the daemon will record it. Resolved through the container so the
  // value follows the MCP handshake rather than a snapshot taken at wiring time.
  const identity = (): RpcMeta => {
    const writer = target.resolve(ClientIdentity).get();

    return { client: writer.client, version: writer.version };
  };

  for (const name of Object.keys(CALL_SURFACE) as CallName[]) {
    // Each entry's token has its own Args/Result pair, and the loop needs one type. The
    // registered value satisfies every one of them: a remote use case is uniform by
    // construction, since it only forwards plain data.
    const token = CALL_SURFACE[name].token as InjectionToken<UseCase<unknown, unknown>>;

    target.register(token, { useValue: new RemoteUseCase(name, options, identity) });
  }
}
