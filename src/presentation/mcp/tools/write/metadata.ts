import z from "zod";
import { EdgeType, MemoryKind } from "@/core/vocab";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.WRITE,

  description:
    "Create a new memory node. Use `memory_kind:'semantic'` for durable facts, decisions, entities, how-tos, or tasks " +
    "that should outlive this session; use `memory_kind:'episodic'` for a record of what happened (an event_note; " +
    "prefer the `checkpoint` tool for session hand-offs). SEARCH FIRST. On a semantic write the server runs a duplicate " +
    "probe and returns `similar_existing` plus a `context_notes` hint when a near-duplicate exists — the " +
    "write still succeeds, but prefer `update` or `link`+`invalidate` over keeping two copies of one fact. Each " +
    "candidate carries a `score` (cosine similarity, or lexical overlap when nothing is embedded yet) and a " +
    "`confidence`: `high` means it also clears the merge threshold, so treat it as the same fact unless you can name " +
    "the difference; `moderate` means related enough to check. Both gates are calibrated per deployment, so a " +
    "candidate appearing at all is meaningful. When a " +
    "generating provider is configured, it also returns `reconcile` — a judged action (`noop`|`update`|`supersede`), " +
    "the `target_id` it applies to, and a reason — so you can act on the duplicate precisely; it is advice, never " +
    "auto-applied. Episodic nodes are write-once. Returns the new node's envelope.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    memory_kind: z
      .nativeEnum(MemoryKind)
      .describe("'episodic' (what happened, write-once) or 'semantic' (a durable fact)."),
    type: z
      .string()
      .describe(
        "Node type: episodic -> checkpoint|event_note; semantic -> fact|decision|entity|howto|task.",
      ),
    title: z.string().min(1).describe("Short human-readable title; shown in every envelope."),
    content: z
      .string()
      .min(1)
      .describe("Markdown body. First non-heading line becomes the summary."),
    project: z.string().optional().describe("Project scope; omit for a global memory."),
    links: z
      .array(z.object({ dst: z.string(), type: z.nativeEnum(EdgeType) }))
      .optional()
      .describe("Edges from this new node to existing nodes."),
    event_from: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Event axis (ISO-8601): when the fact itself became true, as opposed to when you " +
          "wrote it down. Omit unless you actually know it — omitted means no claim, and " +
          "reads treat that as an open interval rather than as unknown.",
      ),
    event_to: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Event axis (ISO-8601): when the fact stopped being true. Must not precede `event_from`.",
      ),
  },
};
