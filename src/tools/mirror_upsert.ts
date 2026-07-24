import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { embeddingNotes } from "@/tools/notes";

export const schema = {
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
          .describe("Opaque structured metadata (status, author, labels, …), returned via `get`."),
      }),
    )
    .min(1)
    .describe("The curated records to mirror. Idempotent by (source, native_id)."),
};

export const description =
  "Upsert curated external records into `mirror` nodes for a registered source. Supply only decision-worthy records " +
  "you fetched yourself via the source's MCP tools — NOT bulk exports (that would flood retrieval). `content` is a " +
  "compact markdown summary you compose; `url` deep-links back; `facets` is opaque metadata. Idempotent by " +
  "(source, native_id): re-syncing identical content is a no-op, changed content adds a revision. It does NOT remove " +
  "records absent from the batch — retire a stale record with `invalidate` on its node id. To connect a record to " +
  "your own notes or to another record, draw a `documents`/`references`/`relates_to` edge with `link`. Returns a " +
  "compact count summary plus the affected node ids (never record content).";

export async function handler(ctx: Ctx, args: ToolArgs<typeof schema>) {
  const hints = touchOrCreate(ctx, args.session_id);

  const source = ctx.repo.getSource(args.source_id);
  if (!source) {
    throw new Error(
      `source '${args.source_id}' is not registered. Register it first with \`source_register\`.`,
    );
  }
  if (!source.enabled) {
    throw new Error(
      `source '${args.source_id}' is disabled. Re-enable it with \`source_register\` (enabled:true) before mirroring.`,
    );
  }

  const result = ctx.repo.upsertMirrors(source, args.items, args.session_id, ctx.now());

  ctx.repo.logEvent(
    "mirror_upsert",
    args.session_id,
    null,
    {
      source_id: source.id,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
    },
    ctx.now(),
  );

  const notes = embeddingNotes(ctx.repo);
  const out: Record<string, unknown> = { ...result };
  if (hints.length) out.hints = hints;
  if (notes.length) out.context_notes = notes;
  return out;
}
