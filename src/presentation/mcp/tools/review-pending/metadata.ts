import { z } from "zod";
import { ReviewArtifact } from "@/core/vocab";
import { sessionIdSchema, ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.REVIEW_PENDING,

  description:
    "List what a `suggest`-posture principal has written and nobody has judged yet — the review queue for " +
    "unattended writers such as the runner. This is NOT `consolidate_suggest`: that queue holds PROPOSALS the sweep " +
    "has not applied, while everything here has already landed in the store, because `suggest` never blocked a " +
    "write — it let it through and marked the audit row. Each item carries the artifact ('edge' or 'node'), a `ref` " +
    "to pass back to `review_resolve` verbatim, the principal that wrote it, when, and enough context to judge it: " +
    "for an edge, its type plus the title and type of both endpoints; for a node, its own title and type. Also " +
    "returns `pending` counts and `reviewing`, which names the principals whose writes land here — an empty queue " +
    "with an empty `reviewing` means nothing is under review at all, which is a different thing from nothing " +
    "waiting. Resolve each with `review_resolve`. Costs the `consolidate` capability, so a principal that writes " +
    "under review cannot clear its own queue.",

  schema: {
    session_id: sessionIdSchema,
    artifact: z
      .nativeEnum(ReviewArtifact)
      .optional()
      .describe("Filter to one kind: edge | node. Omit for both."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Max items (default 20).")
      .optional(),
  },
};
