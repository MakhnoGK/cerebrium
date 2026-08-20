import { NodeReferenceService } from "@/application/services";
import {
  RECORD_CHECKPOINT,
  useCase,
  type EnvelopeResult,
  type RecordCheckpoint,
  type RecordCheckpointArgs,
} from "@/application/use-cases/contracts";
import { NodesRepo } from "@/db/repositories";
import { EdgeType, MemoryKind } from "@/core/vocab";

@useCase(RECORD_CHECKPOINT)
export class LocalRecordCheckpoint implements RecordCheckpoint {
  constructor(
    private readonly references: NodeReferenceService,
    private readonly nodes: NodesRepo,
  ) {}

  async invoke(args: RecordCheckpointArgs): Promise<EnvelopeResult> {
    for (const id of args.touched_node_ids ?? []) {
      this.references.requireLive(id, "touched node");
    }

    return {
      envelope: await this.nodes.createNode({
        memory_kind: MemoryKind.EPISODIC,
        type: "checkpoint",
        title: args.title,
        content: buildBody(args.summary, args.decisions, args.open_threads),
        project: args.project ?? null,
        session_id: args.session_id,
        ts: new Date().toISOString(),
        links: (args.touched_node_ids ?? []).map((dst) => ({ dst, type: EdgeType.REFERENCES })),
      }),
    };
  }
}

function buildBody(summary: string, decisions?: string[], openThreads?: string[]): string {
  const parts = [`## Summary\n${summary.trim()}`];

  if (decisions?.length) {
    parts.push(`## Decisions\n${decisions.map((d) => `- ${d}`).join("\n")}`);
  }

  if (openThreads?.length) {
    parts.push(`## Open threads\n${openThreads.map((t) => `- ${t}`).join("\n")}`);
  }

  return parts.join("\n\n");
}
