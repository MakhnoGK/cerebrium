import { z } from "zod";
import { EDGE_TYPES } from "@/core/vocab";
import { ToolName } from "@/tools/contracts";

export const metadata = {
  name: ToolName.LINK,

  description:
    "Connect two existing nodes with a typed, directed edge (provenance 'agent'). Use this to relate memories you " +
    "created in separate writes — e.g. a decision `references` a fact, a how-to `documents` an entity, a new note " +
    "`supersedes` an old one. Re-linking a previously removed edge revives it. Edges make graph expansion surface " +
    "related context automatically during search. `similar_to` is reserved for the system and rejected here.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    src: z.string().describe("Source node id (the edge points from here)."),
    dst: z.string().describe("Destination node id (the edge points to here)."),
    type: z
      .enum(EDGE_TYPES)
      .describe(
        "references | documents | derived_from | supersedes | relates_to (similar_to is system-only).",
      ),
    weight: z.number().min(0).max(1).optional().describe("Edge strength 0–1 (default 1.0)."),
  },
};
