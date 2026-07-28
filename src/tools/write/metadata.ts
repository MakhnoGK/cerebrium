import z from "zod";
import { _MemoryKind, EDGE_TYPES } from "@/core/vocab";
import { ToolName } from "@/tools/contracts";

export const metadata = {
  name: ToolName.WRITE,

  description:
    "Create a new memory node. Use `memory_kind:'semantic'` for durable facts, decisions, entities, how-tos, or tasks " +
    "that should outlive this session; use `memory_kind:'episodic'` for a record of what happened (an event_note; " +
    "prefer the `checkpoint` tool for session hand-offs). SEARCH FIRST. On a semantic write the server runs a duplicate " +
    "probe and returns `similar_existing` (with scores) plus a `context_notes` hint when a near-duplicate exists — the " +
    "write still succeeds, but prefer `update` or `link`+`invalidate` over keeping two copies of one fact. When a " +
    "generating provider is configured, it also returns `reconcile` — a judged action (`noop`|`update`|`supersede`), " +
    "the `target_id` it applies to, and a reason — so you can act on the duplicate precisely; it is advice, never " +
    "auto-applied. Episodic nodes are write-once. Returns the new node's envelope.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    memory_kind: z
      .nativeEnum(_MemoryKind)
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
      .array(z.object({ dst: z.string(), type: z.enum(EDGE_TYPES) }))
      .optional()
      .describe("Edges from this new node to existing nodes."),
  },
};
