import { ZodRawShape } from "zod";
import type { TouchSession } from "@/application/use-cases";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

export class SessionGuardedTool<Schema extends ZodRawShape, Response> implements McpTool<
  Schema,
  Response
> {
  constructor(
    private readonly tool: McpTool<Schema, Response>,
    private readonly sessions: TouchSession,
  ) {}

  public getMetadata() {
    return this.tool.getMetadata();
  }

  public async invoke(args: ToolArgs<Schema>): Promise<Response> {
    const sessionId = sessionOf(args);

    if (sessionId) {
      await this.sessions.invoke({ session_id: sessionId });
    }

    return this.tool.invoke(args);
  }

  public describeEvent(args: ToolArgs<Schema>, result: Response) {
    return this.tool.describeEvent?.(args, result) ?? null;
  }
}

function sessionOf(args: unknown): string | null {
  const value = (args as { session_id?: unknown }).session_id;

  return typeof value === "string" ? value : null;
}
