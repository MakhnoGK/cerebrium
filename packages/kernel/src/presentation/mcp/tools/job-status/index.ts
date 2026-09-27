import { inject } from "tsyringe";
import { JOB_STATUS, type JobEnvelope, type JobStatus } from "@/application/use-cases";
import { McpTool } from "@/presentation/mcp/tools/contracts";
import { tool } from "@/presentation/mcp/tools/contracts/tool";
import { ToolArgs } from "@/presentation/mcp/tools/contracts/tool-args";
import { metadata } from "@/presentation/mcp/tools/job-status/metadata";

type Schema = (typeof metadata)["schema"];

type ToolResponse = JobEnvelope | { jobs: JobEnvelope[] };

@tool()
export class JobStatusTool implements McpTool<Schema, ToolResponse> {
  public getMetadata = () => metadata;

  constructor(@inject(JOB_STATUS) private readonly status: JobStatus) {}

  async invoke(args: ToolArgs<Schema>): Promise<ToolResponse> {
    const { jobs } = await this.status.invoke({
      session_id: args.session_id,
      id: args.id,
      kind: args.kind,
      limit: args.limit,
    });

    // Asking about one job answers with that job, not a list of one: polling is the common
    // case and `result` should be one dereference away, not two.
    return args.id !== undefined && jobs.length === 1 ? jobs[0]! : { jobs };
  }
}
