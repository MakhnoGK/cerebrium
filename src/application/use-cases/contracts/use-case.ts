import { container, injectable, type InjectionToken } from "tsyringe";

// The seam between a delivery host and the kernel: plain data in, plain data out — no zod,
// no MCP envelope, no database row. Always a promise even when the implementation is
// synchronous, because a uniform shape is what lets a transport-backed implementation be
// substituted for a local one without the caller changing.
export interface UseCase<Args, Result> {
  invoke(args: Args): Promise<Result>;
}

export type UseCaseToken<Args, Result> = InjectionToken<UseCase<Args, Result>>;

export function useCaseToken<Args, Result>(name: string): UseCaseToken<Args, Result> {
  return Symbol(name);
}

// Registers the implementation against the token the callers resolve. A factory rather
// than `useToken`, for the same reason `@tool()` uses one: each container builds its own
// instance against its own DB_TOKEN, which keeps test scopes isolated. A later
// registration of the same token wins, which is how a remote implementation would
// displace a local one.
export function useCase<Args, Result>(token: UseCaseToken<Args, Result>): ClassDecorator {
  return (target) => {
    injectable()(target as never);
    container.register(token, {
      useFactory: (dependencyContainer) => dependencyContainer.resolve(target as never),
    });
  };
}
