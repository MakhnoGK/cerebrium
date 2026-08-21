import { inject } from "tsyringe";
import {
  INDEX_CODE,
  SESSION_HINTS,
  type IndexCode,
  type SessionHints,
} from "@/application/use-cases";
import type { IndexStats } from "@/core/types";
import { metadata } from "@/presentation/mcp/tools/code-index/metadata";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";

type Schema = (typeof metadata)["schema"];

type ToolResponse =
  | (IndexStats & { hints?: string[]; context_notes?: string[] })
  | { repos: IndexStats[]; hints?: string[]; context_notes?: string[] };

@tool()
export class CodeIndexTool implements McpTool<Schema, ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(INDEX_CODE) private readonly index: IndexCode,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const { results, notes } = await this.index.invoke({
      session_id: args.session_id,
      repo: args.repo,
      path: args.path,
      force: args.force,
    });
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });

    const out: ToolResponse = results.length === 1 ? { ...results[0]! } : { repos: results };

    if (hints.length) {
      out.hints = hints;
    }

    if (notes.length) {
      out.context_notes = notes;
    }

    return out;
  }
}
