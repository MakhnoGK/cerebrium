import { ZodRawShape } from "zod";
import { EventLogService } from "@/application/services";
import type { EventDraft } from "@/core/types";
import type { EventAction } from "@/core/vocab";
import { actionForTool } from "@/presentation/mcp/adapters/tool-action";
import { McpTool, ToolEvent } from "@/presentation/mcp/tools/contracts";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

// Invariant #7: every tool call appends an `events` row. This wraps a tool rather than
// living in each handler, so provenance can't be forgotten by a new tool.
export class AuditedTool<Schema extends ZodRawShape, Response> implements McpTool<
  Schema,
  Response
> {
  constructor(
    private readonly tool: McpTool<Schema, Response>,
    private readonly eventLog: EventLogService,
  ) {}

  public getMetadata() {
    return this.tool.getMetadata();
  }

  public async invoke(args: ToolArgs<Schema>): Promise<Response> {
    const action = actionForTool(this.tool.getMetadata().name);

    try {
      const result = await this.tool.invoke(args);

      this.eventLog.record(this.draftsFor(action, args, result));

      return result;
    } catch (error) {
      this.eventLog.record(
        this.toDrafts(action, args, [{ detail: { error: (error as Error).message } }]),
      );

      throw error;
    }
  }

  private draftsFor(action: EventAction, args: ToolArgs<Schema>, result: Response): EventDraft[] {
    const described = this.tool.describeEvent?.(args, result) ?? {};
    const events = Array.isArray(described) ? described : [described];

    return this.toDrafts(action, args, events);
  }

  // A row can only be attributed to a session, and `events.session_id` is NOT NULL — an
  // unattributable call (a `session_start` that threw before minting an id) logs nothing.
  private toDrafts(action: EventAction, args: ToolArgs<Schema>, events: ToolEvent[]): EventDraft[] {
    const fallback = sessionOf(args);

    return events.flatMap((event) => {
      const session_id = event.session_id ?? fallback;

      if (!session_id) {
        return [];
      }

      return [{ action, session_id, node_id: event.node_id, detail: event.detail }];
    });
  }
}

function sessionOf(args: unknown): string | null {
  const value = (args as { session_id?: unknown }).session_id;

  return typeof value === "string" ? value : null;
}
