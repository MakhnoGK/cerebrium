import "@/presentation/mcp/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { injectable, injectAll } from "tsyringe";
import { ZodRawShape } from "zod";
import { EventLogService, SessionService } from "@/application/services";
import { ClientIdentity } from "@/runtime/client-identity";
import { AuditedTool, SessionGuardedTool, ToolOutputAdapter } from "@/presentation/mcp/adapters";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { TOOL_TOKEN } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

@injectable()
export class Server {
  private _server: McpServer;

  constructor(
    @injectAll(TOOL_TOKEN) tools: McpTool<ZodRawShape, unknown>[],
    eventLog: EventLogService,
    sessions: SessionService,
    identity: ClientIdentity,
  ) {
    this._server = new McpServer({ name: "cerebrium", version: "0.1.0" });

    // `initialize` completes before any tool call, so a session minted later is covered.
    this._server.server.oninitialized = () => {
      const client = this._server.server.getClientVersion();

      identity.set({ client: client?.name ?? null, version: client?.version ?? null });
    };

    tools.forEach((tool) => {
      const meta = tool.getMetadata();
      const audited = new AuditedTool(tool, eventLog);
      const guarded = new SessionGuardedTool(audited, sessions);
      const callback = (args: ToolArgs<ZodRawShape>) =>
        new ToolOutputAdapter(guarded).transform(args);

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
