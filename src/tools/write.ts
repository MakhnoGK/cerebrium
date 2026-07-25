import { z } from "zod";
import type { ToolArgs } from "@/tools/context";
import { touchOrCreate } from "@/tools/context";
import { deriveSummary, Envelope } from "@/db/repo";
import { chunkContent } from "@/core/chunk";
import { toFtsMatch } from "@/core/fts";
import { embeddingNotes } from "@/tools/notes";
import { reconcilePosture } from "@/consolidation/config";
import type { ReconcileResult } from "@/consolidation/provider";
import { EDGE_TYPES, MEMORY_KINDS, NODE_TYPES, typeAllowedForKind } from "@/core/vocab";
import { AbstractTool, ToolName } from "@/tools/contracts";
import { tool } from "@/tools/contracts/tool";

const MAX_CONTENT = 50_000;
const DEDUP_CANDIDATES = 5;
const RECONCILE_CANDIDATES = 3;

interface SimilarExisting {
  id: string;
  title: string;
  summary: string;
  score: number;
  suggestion: string;
}

type ToolResponse = Envelope & {
  similar_existing?: unknown;
  reconcile?: unknown;
  hints?: string[];
  context_notes?: unknown;
};

@tool()
export class WriteTool extends AbstractTool {
  name = ToolName.WRITE;

  description =
    "Create a new memory node. Use `memory_kind:'semantic'` for durable facts, decisions, entities, how-tos, or tasks " +
    "that should outlive this session; use `memory_kind:'episodic'` for a record of what happened (an event_note; " +
    "prefer the `checkpoint` tool for session hand-offs). SEARCH FIRST. On a semantic write the server runs a duplicate " +
    "probe and returns `similar_existing` (with scores) plus a `context_notes` hint when a near-duplicate exists — the " +
    "write still succeeds, but prefer `update` or `link`+`invalidate` over keeping two copies of one fact. When a " +
    "generating provider is configured, it also returns `reconcile` — a judged action (`noop`|`update`|`supersede`), " +
    "the `target_id` it applies to, and a reason — so you can act on the duplicate precisely; it is advice, never " +
    "auto-applied. Episodic nodes are write-once. Returns the new node's envelope.";

  schema = {
    session_id: z.string().describe("The id from session_start (auto-created if unknown)."),
    memory_kind: z
      .enum(MEMORY_KINDS)
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
  };

  async invoke(args: ToolArgs<typeof this.schema>): Promise<ToolResponse> {
    const hints = touchOrCreate(this.ctx, args.session_id, args.project ?? null);

    if (args.memory_kind === "mirror") {
      throw new Error(
        "mirror memories (e.g. code symbols) are maintained by the indexer, not written by hand. Run `code_index` to " +
          "index code; write 'semantic' for a decision/gotcha ABOUT code and `link` it to the symbol with a 'documents' edge.",
      );
    }

    const kind = args.memory_kind;

    if (!typeAllowedForKind(kind, args.type)) {
      throw new Error(
        `type '${args.type}' is not valid for ${kind} memories. Allowed: ${NODE_TYPES[kind].join(", ")}.`,
      );
    }

    if (args.content.length > MAX_CONTENT) {
      throw new Error(
        `content is ${args.content.length} chars; the limit is ${MAX_CONTENT}. Split this into smaller linked notes.`,
      );
    }

    for (const link of args.links ?? []) {
      if (!this.ctx.repo.nodeExists(link.dst)) {
        throw new Error(
          `link destination '${link.dst}' does not exist. Create it first or fix the id.`,
        );
      }
    }

    // Dedup probe before insert — semantic only, checkpoints exempt. Never blocks.
    const similar = kind === "semantic" ? await this.dedupProbe(args) : [];

    const envelope = this.ctx.repo.createNode({
      memory_kind: kind,
      type: args.type,
      title: args.title,
      content: args.content,
      project: args.project ?? null,
      session_id: args.session_id,
      ts: this.ctx.now(),
      links: args.links,
    });

    this.ctx.repo.logEvent(
      "write",
      args.session_id,
      envelope.id,
      { type: args.type, kind },
      this.ctx.now(),
    );

    // When a duplicate is found and a judging provider is configured, sharpen the advisory
    // hint into a specific action. Never blocks, never applies — the agent decides.
    const reconcile =
      similar.length && this.ctx.consolidator.enabled && reconcilePosture() !== "off"
        ? await this.tryReconcile(args, similar)
        : null;

    const notes = embeddingNotes(this.ctx.repo);

    if (similar.length) {
      notes.unshift(
        `Possible duplicate of ${similar[0]!.id} — if same fact, invalidate one with superseded_by.`,
      );
    }

    const out: ToolResponse = { ...envelope };

    if (similar.length) out.similar_existing = similar;
    if (reconcile) out.reconcile = reconcile;
    if (hints.length) out.hints = hints;
    if (notes.length) out.context_notes = notes;

    return out;
  }

  // Ask the provider to judge the new draft against its nearest existing records: keep,
  // update one, or supersede one. Reads full content for the top few candidates (they
  // already cleared the dedup threshold). Advisory: any failure returns null, so the writing
  // is unaffected, and a non-noop verdict must name a real candidate, or it decays to noop.
  private async tryReconcile(
    args: ToolArgs<typeof this.schema>,
    similar: SimilarExisting[],
  ): Promise<ReconcileResult | null> {
    try {
      const candidates = similar
        .slice(0, RECONCILE_CANDIDATES)
        .map((s) => {
          const full = this.ctx.repo.fullNode(s.id);
          return full ? { id: s.id, title: full.envelope.title, content: full.content } : null;
        })
        .filter((c): c is { id: string; title: string; content: string } => c !== null);

      if (!candidates.length) return null;

      const res = await this.ctx.consolidator.reconcile({
        draft: { title: args.title, type: args.type, content: args.content },
        project: args.project ?? null,
        candidates,
      });

      if (res.action !== "noop" && !candidates.some((c) => c.id === res.target_id)) {
        return { action: "noop", target_id: null, reason: res.reason };
      }

      return res;
    } catch {
      return null;
    }
  }

  // Cheap hybrid probe with the new title + first chunk. Prefers vector cosine; when
  // nothing is embedded yet (or the provider is down), it falls back to lexical
  // Jaccard over the FTS candidates, so it never blocks and never throws.
  private async dedupProbe(args: ToolArgs<typeof this.schema>): Promise<SimilarExisting[]> {
    try {
      const firstChunk = chunkContent("probe", args.content)[0]?.text ?? args.content;
      const probe = `${args.title}\n${firstChunk}`;
      const opts = {
        project: args.project,
        kinds: ["semantic"],
        history: false,
        cap: DEDUP_CANDIDATES,
      };

      let scored: SimilarExisting[] = [];
      const [qvec] = await this.ctx.provider.embed([probe], "query");

      if (qvec) {
        scored = this.ctx.repo.vectorSearch(qvec, opts).map((r) => ({
          id: r.id,
          title: r.title,
          summary: deriveSummary(r.content),
          score: 1 - r.distance, // cosine similarity
          suggestion: "consider update or link + invalidate instead",
        }));
      }

      if (!scored.length) {
        const match = toFtsMatch(probe);
        if (match) {
          const probeTokens = tokenSet(probe);
          scored = this.ctx.repo
            .search({
              match,
              project: args.project,
              kinds: ["semantic"],
              history: false,
              cap: DEDUP_CANDIDATES,
            })
            .rows.map((r) => ({
              id: r.id,
              title: r.title,
              summary: deriveSummary(r.content),
              score: jaccard(probeTokens, tokenSet(`${r.title} ${r.content}`)),
              suggestion: "consider update or link + invalidate instead",
            }));
        }
      }

      const threshold = dedupThreshold();

      return scored
        .filter((c) => c.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((c) => ({ ...c, score: Math.round(c.score * 100) / 100 }));
    } catch {
      return []; // dedup is advisory; a probe failure must never block the writing
    }
  }
}

// Read at call time, so it is tunable per-run (and per-test) via env.
function dedupThreshold(): number {
  return Number(process.env.MEMORY_DEDUP_THRESHOLD) || 0.82;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;

  return inter / (a.size + b.size - inter);
}
