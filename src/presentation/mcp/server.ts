import "@/presentation/mcp/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { injectable, injectAll } from "tsyringe";
import { ZodRawShape } from "zod";
import { ClientIdentity } from "@/runtime/client-identity";
import { ToolOutputAdapter } from "@/presentation/mcp/adapters";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { TOOL_TOKEN } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { IdentityConfig } from "@/infrastructure/config";

@injectable()
export class Server {
  private _server: McpServer;

  constructor(
    @injectAll(TOOL_TOKEN) tools: McpTool<ZodRawShape, unknown>[],
    identity: ClientIdentity,
    config: IdentityConfig,
  ) {
    this._server = new McpServer({ name: "cerebrium", version: "0.1.0" });

    const pinned = config.client;

    // Set before connecting as well as on the handshake: a pinned identity has to hold for
    // anything that happens before `initialize` completes, and the handshake may never
    // complete at all.
    if (pinned !== null) {
      identity.set({ client: pinned, version: null });
    }

    // `initialize` completes before any tool call, so a session minted later is covered.
    // The pin wins over the reported name — a headless agent CLI reports the same name as
    // the interactive one, so the name is the only part the host can be trusted on — while
    // the reported version is still worth keeping.
    this._server.server.oninitialized = () => {
      const client = this._server.server.getClientVersion();

      identity.set({
        client: pinned ?? client?.name ?? null,
        version: client?.version ?? null,
      });
    };

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
