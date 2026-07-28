import { container, injectable, InjectionToken } from "tsyringe";
import { ZodRawShape } from "zod";
import { ToolName } from "@/tools/contracts/tool-name";
import { ToolArgs } from "@/tools/context";

export const TOOL_TOKEN: InjectionToken<McpTool<ZodRawShape, unknown>> = Symbol("TOOL_TOKEN");

export function tool(): ClassDecorator {
  return (target) => {
    injectable()(target as never);
    // Transient (not instance-cached): each container that resolves the tool set builds
    // fresh instances against its own DB_TOKEN. The server resolves the set once at
    // startup, so this costs nothing in production, and it keeps test scopes isolated.
    container.register(TOOL_TOKEN, {
      useFactory: (dependencyContainer) => dependencyContainer.resolve(target as never),
    });
  };
}

export interface McpTool<Schema extends ZodRawShape, Response> {
  getMetadata(): { name: ToolName; description: string; schema: Schema };
  invoke(args: ToolArgs<Schema>): Promise<Response>;
}
