import { inject } from "tsyringe";
import {
  SESSION_HINTS,
  SUBMIT_JOB,
  type JobEnvelope,
  type SessionHints,
  type SubmitJob,
} from "@/application/use-cases";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "@/presentation/mcp/tools/job-submit/metadata";

type Schema = (typeof metadata)["schema"];

type ToolResponse = JobEnvelope & { hints?: string[] };

@tool()
export class JobSubmitTool implements McpTool<Schema, ToolResponse> {
  public getMetadata = () => metadata;

  constructor(
    @inject(SESSION_HINTS) private readonly sessionHints: SessionHints,
    @inject(SUBMIT_JOB) private readonly submit: SubmitJob,
  ) {}

  async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const { job } = await this.submit.invoke({
      session_id: args.session_id,
      kind: args.kind,
      payload: args.payload,
      scheduled_for: args.scheduled_for,
    });
    const { hints } = await this.sessionHints.invoke({ session_id: args.session_id });

    return hints.length ? { ...job, hints } : job;
  }
}
