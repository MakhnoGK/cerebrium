import { z } from "zod";
import { ToolName } from "@/presentation/mcp/tools/contracts";

export const metadata = {
  name: ToolName.MIRROR_UPSERT,

  description:
    "Upsert curated external records into `mirror` nodes for a registered source. Supply only decision-worthy records " +
    "you fetched yourself via the source's MCP tools — NOT bulk exports (that would flood retrieval). `content` is a " +
    "compact markdown summary you compose; `url` deep-links back; `facets` is opaque metadata. Idempotent by " +
    "(source, native_id): re-syncing identical content is a no-op, changed content adds a revision. It does NOT remove " +
    "records absent from the batch — retire a stale record with `invalidate` on its node id. To connect a record to " +
    "your own notes or to another record, draw a `documents`/`references`/`relates_to` edge with `link`. Returns a " +
    "compact count summary plus the affected node ids (never record content).",

  schema: {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    source_id: z
      .string()
      .describe("A source registered (and enabled) via `source_register`, e.g. 'grafana-prod'."),
    items: z
      .array(
        z.object({
          native_id: z
            .string()
            .min(1)
            .describe("The source's own id for this record (issue key, message ts, chart id)."),
          type: z
            .string()
            .min(1)
            .describe("Record type — open vocab, e.g. 'incident', 'thread', 'chart', 'test_case'."),
          title: z.string().min(1).describe("Short human title for the record."),
          content: z
            .string()
            .min(1)
            .describe("A compact markdown summary YOU composed from the source — not a bulk dump."),
          url: z.string().optional().describe("Deep link back to the record in its source tool."),
          project: z
            .string()
            .optional()
            .describe("Override the source's default project scope for this record."),
          facets: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Opaque structured metadata (status, author, labels, …), returned via `get`.",
            ),
        }),
      )
      .min(1)
      .describe("The curated records to mirror. Idempotent by (source, native_id)."),
  },
};
