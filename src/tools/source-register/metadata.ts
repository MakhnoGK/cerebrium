import { z } from "zod";
import { ToolName } from "@/tools/contracts";

export const metadata = {
  name: ToolName.SOURCE_REGISTER,

  description:
    "Register (or update) an external mirror source for THIS deployment before mirroring records to it. `id` is a " +
    "local instance (e.g. 'grafana-prod'); `kind` becomes the `origin` of every mirror node from it. This stores NO " +
    "credentials and connects to nothing — you fetch from the source with your own MCP tools, then write curated " +
    "records with `mirror_upsert`. Re-registering the same `id` updates it in place. The registry is empty in a fresh " +
    "deployment, so a Cerebrium with a different toolset simply registers different sources. Returns the stored source.",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    id: z
      .string()
      .min(1)
      .describe("Deployment-local instance id for this source, e.g. 'grafana-prod', 'sentry'."),
    kind: z
      .string()
      .min(1)
      .describe(
        "Source kind — becomes each mirror node's `origin`, e.g. 'grafana', 'slack', 'jira'.",
      ),
    label: z.string().optional().describe("Human label, e.g. 'Grafana (prod)'."),
    project: z
      .string()
      .optional()
      .describe(
        "Default project scope for this source's mirror nodes (mirror_upsert may override).",
      ),
    freshness_hours: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Staleness threshold in hours; omit to never report this source stale."),
    recipe: z
      .string()
      .optional()
      .describe("Pointer to the docs/mirrors/*.md recipe that documents how to sync this source."),
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Whether the source is active (default true); set false to pause without forgetting.",
      ),
  },
};
