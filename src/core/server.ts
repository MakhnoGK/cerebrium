import "@/core/context";
import "@/tools";

import { injectable, injectAll } from "tsyringe";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_TOKEN } from "@/tools/contracts/tool";
import { AbstractTool } from "@/tools/contracts";
import { ToolOutputAdapter } from "@/core/adapters";
import { ToolArgs } from "@/tools/context";

@injectable()
export class Server {
  private server: McpServer;

  constructor(@injectAll(TOOL_TOKEN) tools: AbstractTool[]) {
    this.server = new McpServer({ name: "cerebrium", version: "0.1.0" });

    tools.forEach((tool) => {
      const callback = (args: ToolArgs<typeof tool.schema>) =>
        new ToolOutputAdapter(tool).transform(args);

      this.server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema },
        callback,
      );
    });
  }

  async connect() {
    await this.server.connect(new StdioServerTransport());
  }
}
