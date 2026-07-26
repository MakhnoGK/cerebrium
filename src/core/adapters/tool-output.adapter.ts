import { AbstractTool } from "@/tools/contracts";
import { ToolArgs } from "@/tools/context";

export class ToolOutputAdapter {
  constructor(private tool: AbstractTool) {}

  public async transform(args: ToolArgs<typeof this.tool.schema>) {
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
