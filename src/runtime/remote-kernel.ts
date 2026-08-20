import type { DependencyContainer, InjectionToken } from "tsyringe";
import { CALL_SURFACE, type CallName, type UseCase } from "@/application/use-cases";
import { rpcCall } from "@/runtime/rpc-client";

// The remote kernel. It registers the same use-case tokens as the local one, against a
// socket client instead of a database — which is the whole payoff of addressing use cases
// by token and interface rather than by concrete class.
//
// What it deliberately does NOT register is the kernel itself: no database handle, no
// providers, no repositories. A host in this mode cannot reach the file even by accident,
// and resolving a repository throws instead of quietly opening a second connection to a
// database another process is writing.

export interface RemoteKernelOptions {
  socketPath: string;
  timeoutMs?: number;
}

class RemoteUseCase implements UseCase<unknown, unknown> {
  constructor(
    private readonly name: CallName,
    private readonly options: RemoteKernelOptions,
  ) {}

  invoke(args: unknown): Promise<unknown> {
    return rpcCall(
      {
        socketPath: this.options.socketPath,
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      },
      this.name,
      // Arguments cross as JSON, so they must already be plain data. They are: the seam was
      // defined that way precisely so a remote implementation could substitute here.
      (args ?? {}) as Record<string, unknown>,
    );
  }
}

export function registerRemoteKernel(
  target: DependencyContainer,
  options: RemoteKernelOptions,
): void {
  for (const name of Object.keys(CALL_SURFACE) as CallName[]) {
    // Each entry's token has its own Args/Result pair, and the loop needs one type. The
    // registered value satisfies every one of them: a remote use case is uniform by
    // construction, since it only forwards plain data.
    const token = CALL_SURFACE[name].token as InjectionToken<UseCase<unknown, unknown>>;

    target.register(token, { useValue: new RemoteUseCase(name, options) });
  }
}
