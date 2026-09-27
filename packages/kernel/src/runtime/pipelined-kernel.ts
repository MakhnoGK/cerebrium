import type { DependencyContainer, InjectionToken } from "tsyringe";
import { CallPipeline } from "@/application/call-pipeline";
import { CALL_SURFACE, type CallName, type UseCase } from "@/application/use-cases";
import { ClientIdentity } from "@/runtime/client-identity";

// The local counterpart of `registerRemoteKernel`: the same call surface, forwarded to the
// in-process pipeline instead of a socket, so the session check, the capability posture,
// the quota and the audit row apply on both paths.

class PipelinedUseCase implements UseCase<unknown, unknown> {
  constructor(
    private readonly name: CallName,
    private readonly pipeline: CallPipeline,
    // The container the pipeline resolves the real use case from. It must be the parent:
    // resolving against the child would find this forwarder again and recurse forever.
    private readonly source: DependencyContainer,
    private readonly identity: () => ClientIdentity,
  ) {}

  async invoke(args: unknown): Promise<unknown> {
    return await this.pipeline.invoke(this.source, this.name, args, this.identity().get());
  }
}

export function pipelinedContainer(parent: DependencyContainer): DependencyContainer {
  const child = parent.createChildContainer();
  const pipeline = parent.resolve(CallPipeline);
  // Read per call, not per registration: the MCP handshake that names the client happens
  // after the container is built.
  const identity = () => parent.resolve(ClientIdentity);

  for (const name of Object.keys(CALL_SURFACE) as CallName[]) {
    const token = CALL_SURFACE[name].token as InjectionToken<UseCase<unknown, unknown>>;

    child.register(token, {
      useValue: new PipelinedUseCase(name, pipeline, parent, identity),
    });
  }

  return child;
}
