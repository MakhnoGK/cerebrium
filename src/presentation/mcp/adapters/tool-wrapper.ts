import { container, inject, injectable, type InjectionToken } from "tsyringe";
import {
  RECORD_EVENTS,
  TOUCH_SESSION,
  type RecordEvents,
  type TouchSession,
} from "@/application/use-cases";
import { AuditedTool } from "@/presentation/mcp/adapters/audited-tool.adapter";
import { SessionGuardedTool } from "@/presentation/mcp/adapters/session-guarded-tool.adapter";
import type { McpTool } from "@/presentation/mcp/tools/contracts";

// Whether this host applies the session guard and the audit row itself, or whether
// something downstream already did. Extracted from the server's constructor because the
// answer depends on the kernel, and the server should not have to hold dependencies it
// does not use in one of the two modes.
export interface ToolWrapper {
  wrap(tool: McpTool<never, unknown>): McpTool<never, unknown>;
}

export const TOOL_WRAPPER: InjectionToken<ToolWrapper> = Symbol("ToolWrapper");

@injectable()
export class GuardedToolWrapper implements ToolWrapper {
  constructor(
    @inject(RECORD_EVENTS) private readonly eventLog: RecordEvents,
    @inject(TOUCH_SESSION) private readonly sessions: TouchSession,
  ) {}

  wrap(tool: McpTool<never, unknown>): McpTool<never, unknown> {
    return new SessionGuardedTool(new AuditedTool(tool, this.eventLog), this.sessions);
  }
}

// Guarding is the default, registered at import time the way `@tool()` and `@useCase()`
// register themselves. A host talking to the daemon overrides it; anything that resolves
// the server without choosing gets the safe behaviour rather than an unregistered token.
container.register(TOOL_WRAPPER, { useToken: GuardedToolWrapper });

// For a host talking to the daemon: the daemon's call pipeline already validates the
// session and writes the audit row, so wrapping again would check twice and log every call
// twice. It also cannot wrap — neither token is on the remote surface, by design.
export class PassThroughToolWrapper implements ToolWrapper {
  wrap(tool: McpTool<never, unknown>): McpTool<never, unknown> {
    return tool;
  }
}
