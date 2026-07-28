import "@/tools";

import { injectable, injectAll } from "tsyringe";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOL_TOKEN } from "@/tools/contracts/tool";
import { McpTool } from "@/tools/contracts";
import { ToolOutputAdapter } from "@/core/adapters";
import { ToolArgs } from "@/tools/context";
import { ZodRawShape } from "zod";

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
