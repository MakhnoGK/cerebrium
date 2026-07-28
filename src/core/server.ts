import "@/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { injectable, injectAll } from "tsyringe";
import { ZodRawShape } from "zod";
import { ToolOutputAdapter } from "@/core/adapters";
import { ToolArgs } from "@/tools/context";
import { McpTool } from "@/tools/contracts";
import { TOOL_TOKEN } from "@/tools/contracts/tool";

@injectable()
export class Server {
  private _server: McpServer;

  constructor(@injectAll(TOOL_TOKEN) tools: McpTool<ZodRawShape, unknown>[]) {
    this._server = new McpServer({ name: "cerebrium", version: "0.1.0" });

    tools.forEach((tool) => {
      const meta = tool.getMetadata();
      const callback = (args: ToolArgs<ZodRawShape>) => new ToolOutputAdapter(tool).transform(args);

      this._server.registerTool(
        meta.name,
        { description: meta.description, inputSchema: meta.schema },
        callback,
      );
    });
  }

  async connect(transport?: Transport) {
    await this._server.connect(transport ?? new StdioServerTransport());
  }
}
