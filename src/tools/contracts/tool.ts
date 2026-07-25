import { container, instanceCachingFactory, InjectionToken } from "tsyringe";
import type { Context } from "@/core/context";
import type { AbstractTool } from "@/tools/contracts/abstract-tool";

export const TOOL_TOKEN: InjectionToken<AbstractTool> = Symbol("TOOL_TOKEN");

type ToolCtor = new (ctx: Context) => AbstractTool;

export function tool(): ClassDecorator {
  return (target) => {
    const Ctor = target as unknown as ToolCtor;
    container.register(TOOL_TOKEN, {
      useFactory: instanceCachingFactory((c) => new Ctor(c.resolve<Context>("Ctx"))),
    });
  };
}
