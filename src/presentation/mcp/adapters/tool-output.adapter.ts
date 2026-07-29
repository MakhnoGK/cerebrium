import { ZodRawShape } from "zod";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

export class ToolOutputAdapter {
  constructor(private tool: McpTool<ZodRawShape, unknown>) {}

  public async transform(args: ToolArgs<ZodRawShape>) {
    return this.tool
      .invoke(args)
      .then((data) => ({
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      }))
      .catch((reason: unknown) => ({
        isError: true as const,
        content: [{ type: "text" as const, text: (reason as Error).message }],
      }));
  }
}
