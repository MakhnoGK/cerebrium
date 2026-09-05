import { inject } from "tsyringe";
import {
  LIST_REVIEWS,
  SESSION_HINTS,
  type ListReviews,
  type SessionHints,
} from "@/application/use-cases";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "@/presentation/mcp/tools/review-pending/metadata";

type Schema = (typeof metadata)["schema"];

@tool()
export class ReviewPendingTool implements McpTool<Schema, unknown> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(LIST_REVIEWS) private readonly reviews: ListReviews,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<unknown> {
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });
    const result = await this.reviews.invoke({
      session_id: args.session_id,
      ...(args.artifact === undefined ? {} : { artifact: args.artifact }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });

    const out: Record<string, unknown> = { ...result };

    if (hints.length) out.hints = hints;

    return out;
  }
}
