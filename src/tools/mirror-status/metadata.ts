import { ToolName } from "@/tools/contracts";
import { z } from "zod";

export const metadata = {
  name: ToolName.MIRROR_STATUS,

  description:
    "List the registered external mirror sources for this deployment with their freshness: last sync time, hours " +
    "since, whether each is `stale` (enabled + past its `freshness_hours`, or never synced), and how many live mirror " +
    "nodes it has. Use it to decide what to re-sync; `session_start` also surfaces stale sources automatically. " +
    "Envelopes only — no record content. Returns an empty list when no sources are registered.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    source_id: z
      .string()
      .optional()
      .describe("Narrow to one registered source; omit to list them all."),
  },
};
