import { container, injectable, InjectionToken } from "tsyringe";
import { ZodRawShape } from "zod";
import { ToolArgs } from "./tool-args";
import { ToolName } from "./tool-name";

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

// What only the tool can know about the call it just served. `action` and `ts` are
// filled in at the boundary; `session_id` defaults to the one in `args`.
export interface ToolEvent {
  session_id?: string;
  node_id?: string | null;
  detail?: unknown;
}

export interface McpTool<Schema extends ZodRawShape, Response> {
  getMetadata(): { name: ToolName; description: string; schema: Schema };
  invoke(args: ToolArgs<Schema>): Promise<Response>;
  describeEvent?(args: ToolArgs<Schema>, result: Response): ToolEvent | ToolEvent[] | null;
}
