import { container, injectable, InjectionToken, instanceCachingFactory } from "tsyringe";
import type { AbstractTool } from "@/tools/contracts/abstract-tool";

export const TOOL_TOKEN: InjectionToken<AbstractTool> = Symbol("TOOL_TOKEN");

export function tool(): ClassDecorator {
  return (target) => {
    injectable()(target as never);
    container.register(TOOL_TOKEN, {
      useFactory: instanceCachingFactory((dependencyContainer) =>
        dependencyContainer.resolve(target as never),
      ),
    });
  };
}
