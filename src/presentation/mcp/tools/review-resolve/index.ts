import { inject } from "tsyringe";
import {
  RESOLVE_REVIEW,
  SESSION_HINTS,
  type ResolveReview,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "@/presentation/mcp/tools/review-resolve/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class ReviewResolveTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(RESOLVE_REVIEW) private readonly resolve: ResolveReview,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const result = await this.resolve.invoke({
      session_id: args.session_id,
      artifact: args.artifact,
      ref: args.ref,
      decision: args.decision,
      ...(args.note === undefined ? {} : { note: args.note }),
    });

    const out: Record<string, unknown> = { ok: true, ...result };

    if (hints.length) out.hints = hints;

    return out;
  }
}
