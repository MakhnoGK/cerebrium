import { container, injectable, InjectionToken, instanceCachingFactory } from "tsyringe";
import type { AbstractTool } from "@/tools/contracts/abstract-tool";
import { ZodRawShape } from "zod";
import { ToolName } from "@/tools/contracts/tool-name";
import { ToolArgs } from "@/tools/context";

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

export interface McpTool<Schema extends ZodRawShape, Response> {
  getMetadata(): { name: ToolName; description: string; schema: Schema };
  invoke(args: ToolArgs<Schema>): Promise<Response>;
}
