import { z } from "zod";
import { ReviewArtifact, ReviewDecision } from "@/core/vocab";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.REVIEW_RESOLVE,

  description:
    "Judge one item from `review_pending`. `kept` closes it and changes nothing — the write stands. `undone` " +
    "soft-deletes what was written: an edge is retired, a node is invalidated. Nothing is deleted outright, so an " +
    "undo is recoverable the same way any other retirement is. Pass the item's `ref` back exactly as it was given " +
    "(a node id, or `src|dst|type` for an edge) together with its `artifact`. Resolving is idempotent: deciding " +
    "again overwrites the earlier decision, and undoing something already gone records the decision without moving " +
    "the original retirement's timestamp. Costs the `consolidate` capability.",

  schema: {
    session_id: sessionIdSchema,
    artifact: z
      .nativeEnum(ReviewArtifact)
      .describe("What the ref points at: edge | node. Copy it from the item."),
    ref: z
      .string()
      .min(1)
      .describe("The item's `ref`, verbatim: a node id, or `src|dst|type` for an edge."),
    decision: z
      .nativeEnum(ReviewDecision)
      .describe("kept — the write stands. undone — retire what was written."),
    note: z.string().optional().describe("Why, for whoever reads the decision later."),
  },
};
