import { injectable, injectAll } from "tsyringe";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_TOKEN } from "@/tools/contracts/tool";
import { AbstractTool } from "@/tools/contracts";
import "@/core/context";
import "@/tools";

@injectable()
export class Server {
  private server: McpServer;

  constructor(@injectAll(TOOL_TOKEN) tools: AbstractTool[]) {
    this.server = new McpServer({ name: "cerebrium", version: "0.1.0" });

    tools.forEach((tool) => {
      this.server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema },
        (args) => tool.callback(args),
      );
    });
  }

  async connect() {
    await this.server.connect(new StdioServerTransport());
  }
}
