import { z } from "zod";
import type { Ctx, ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { embeddingNotes } from "@/tools/notes";
import { EDGE_TYPES, SYSTEM_EDGE_TYPES } from "@/core/vocab";

export const schema = {
  session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
  src: z.string().describe("Source node id (the edge points from here)."),
  dst: z.string().describe("Destination node id (the edge points to here)."),
  type: z
    .enum(EDGE_TYPES)
    .describe(
      "references | documents | derived_from | supersedes | relates_to (similar_to is system-only).",
    ),
  weight: z.number().min(0).max(1).optional().describe("Edge strength 0–1 (default 1.0)."),
};

export const description =
  "Connect two existing nodes with a typed, directed edge (provenance 'agent'). Use this to relate memories you " +
  "created in separate writes — e.g. a decision `references` a fact, a how-to `documents` an entity, a new note " +
  "`supersedes` an old one. Re-linking a previously removed edge revives it. Edges make graph expansion surface " +
  "related context automatically during search. `similar_to` is reserved for the system and rejected here.";

export async function handler(ctx: Ctx, args: ToolArgs<typeof schema>) {
  const hints = touchOrCreate(ctx, args.session_id);

  if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(args.type)) {
    throw new Error(
      `'${args.type}' edges are created by the system, not via link. Use another edge type.`,
    );
  }
  if (args.src === args.dst) throw new Error("cannot link a node to itself.");
  if (!ctx.repo.nodeExists(args.src)) throw new Error(`src node ${args.src} does not exist.`);
  if (!ctx.repo.nodeExists(args.dst)) throw new Error(`dst node ${args.dst} does not exist.`);

  const weight = args.weight ?? 1.0;
  ctx.repo.insertEdge(args.src, args.dst, args.type, "agent", args.session_id, ctx.now(), weight);
  ctx.repo.logEvent(
    "link",
    args.session_id,
    args.src,
    { dst: args.dst, type: args.type, weight },
    ctx.now(),
  );

  const notes = embeddingNotes(ctx.repo);
  const out: Record<string, unknown> = {
    ok: true,
    src: args.src,
    dst: args.dst,
    type: args.type,
    weight,
  };
  if (hints.length) out.hints = hints;
  if (notes.length) out.context_notes = notes;
  return out;
}
