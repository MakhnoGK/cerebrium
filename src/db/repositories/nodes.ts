import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import { BaseRepo, DB_TOKEN } from "@/db/repositories/base";
import { EdgesRepo } from "@/db/repositories/edges";
import { enrichedById, ftsPut, insertRevision, syncChunks } from "@/db/repositories/internal";
import { newId } from "@/core/ids";
import type { Envelope, NeighborStub, NewNode, RevisionMeta } from "@/core/types";
import { toEnvelope } from "@/core/types";
import { EdgeType } from "@/core/vocab";

// The authored-node write path (nodes + revisions + FTS + chunks/queue, atomically)
// and node reads. The append-only-revisions and FTS-in-write-transaction invariants
// live here, explicit in SQL. Edge writes are delegated to EdgesRepo so the graph
// stays a single owner.
@injectable()
export class NodesRepo extends BaseRepo {
  constructor(
    @inject(DB_TOKEN) db: Database.Database,
    private readonly edges: EdgesRepo,
  ) {
    super(db);
  }

  async exists(id: string): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id);
  }

  // The mirror provenance of a node, or undefined if it doesn't exist. Lets the
  // invalidate guard tell a code mirror (origin='repo', indexer-only) from an
  // external mirror (agent-curated, retirable by hand) from an authored node.
  nodeOrigin(id: string): { memory_kind: string; origin: string | null } | undefined {
    return this.db.prepare("SELECT memory_kind, origin FROM nodes WHERE id = ?").get(id) as
      { memory_kind: string; origin: string | null } | undefined;
  }

  envelope(id: string): Envelope | undefined {
    const row = enrichedById(this.db, id);
    return row ? toEnvelope(row) : undefined;
  }

  async fullNode(
    id: string,
  ): Promise<{ envelope: Envelope; content: string; edges: NeighborStub[] } | undefined> {
    const row = enrichedById(this.db, id);
    if (!row) return undefined;

    return { envelope: toEnvelope(row), content: row.content, edges: this.edges.edgesOf(id) };
  }

  listRevisions(id: string): RevisionMeta[] {
    return this.db
      .prepare("SELECT rev, ts, session_id, reason FROM revisions WHERE node_id = ? ORDER BY rev")
      .all(id) as RevisionMeta[];
  }

  revisionContent(id: string, rev: number): string | undefined {
    const row = this.db
      .prepare("SELECT content FROM revisions WHERE node_id = ? AND rev = ?")
      .get(id, rev) as { content: string } | undefined;

    return row?.content;
  }

  async createNode(input: NewNode): Promise<Envelope> {
    const id = newId();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO nodes (id, memory_kind, type, title, project, valid_from, created_by_session, created_at, event_from, event_to)
           VALUES (@id, @kind, @type, @title, @project, @ts, @session, @ts, @eventFrom, @eventTo)`,
        )
        .run({
          id,
          kind: input.memory_kind,
          type: input.type,
          title: input.title,
          project: input.project,
          ts: input.ts,
          session: input.session_id,
          eventFrom: input.event_from ?? null,
          eventTo: input.event_to ?? null,
        });
      insertRevision(this.db, id, 1, input.content, input.session_id, null, input.ts);
      ftsPut(this.db, id, input.title, input.content);
      syncChunks(this.db, id, 1, input.content, input.ts);
      for (const link of input.links ?? []) {
        this.edges.insertEdge(id, link.dst, link.type, "agent", input.session_id, input.ts);
      }
    });
    return this.envelope(id)!;
  }

  // Distillation apply: create one durable semantic/fact node from a cluster of
  // episodic sources, atomically — same write path as createNode (revision + FTS +
  // chunks/queue), plus a derived_from edge to each source and a consolidated_at stamp
  // on each. One transaction: a new fact never lands with its sources left unmarked
  // (which would re-trigger distillation). Sources stay queryable via history.
  applyDistillation(input: {
    title: string;
    content: string;
    project: string | null;
    sourceIds: string[];
    session_id: string;
    ts: string;
  }): Envelope {
    const id = newId();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO nodes (id, memory_kind, type, title, project, valid_from, created_by_session, created_at)
           VALUES (@id, 'semantic', 'fact', @title, @project, @ts, @session, @ts)`,
        )
        .run({
          id,
          title: input.title,
          project: input.project,
          ts: input.ts,
          session: input.session_id,
        });
      insertRevision(this.db, id, 1, input.content, input.session_id, null, input.ts);
      ftsPut(this.db, id, input.title, input.content);
      syncChunks(this.db, id, 1, input.content, input.ts);
      const mark = this.db.prepare(
        `UPDATE nodes SET consolidated_at = @ts
         WHERE id = @src AND memory_kind = 'episodic' AND consolidated_at IS NULL`,
      );
      for (const src of input.sourceIds) {
        this.edges.insertEdge(id, src, EdgeType.DERIVED_FROM, "system", input.session_id, input.ts);
        mark.run({ ts: input.ts, src });
      }
    });
    return this.envelope(id)!;
  }

  // Merge apply: fold `loserId` into `survivorId`, atomically. Optionally revise
  // the survivor to a merged body, re-point the loser's authored edges onto the survivor
  // (system edges like similar_to are left to be recomputed), then invalidate the loser
  // with supersedes -> survivor. The loser stays queryable via history.
  applyMerge(input: {
    survivorId: string;
    loserId: string;
    session_id: string;
    ts: string;
    merged?: { title: string; body: string };
  }): Envelope {
    this.tx(() => {
      if (input.merged) {
        this.addRevision(input.survivorId, {
          content: input.merged.body,
          title: input.merged.title,
          session_id: input.session_id,
          reason: "merge",
          ts: input.ts,
        });
      }
      const incident = this.db
        .prepare(
          `SELECT src, dst, type, weight FROM edges
           WHERE invalidated_at IS NULL AND provenance = 'agent' AND (src = @loser OR dst = @loser)`,
        )
        .all({ loser: input.loserId }) as {
        src: string;
        dst: string;
        type: string;
        weight: number;
      }[];
      const invalidateEdge = this.db.prepare(
        "UPDATE edges SET invalidated_at = @ts WHERE src = @src AND dst = @dst AND type = @type",
      );
      for (const e of incident) {
        invalidateEdge.run({ ts: input.ts, src: e.src, dst: e.dst, type: e.type });
        const nsrc = e.src === input.loserId ? input.survivorId : e.src;
        const ndst = e.dst === input.loserId ? input.survivorId : e.dst;
        if (nsrc === ndst) continue; // self-loop after re-point -> drop
        this.edges.insertEdge(
          nsrc,
          ndst,
          e.type as EdgeType,
          "agent",
          input.session_id,
          input.ts,
          e.weight,
        );
      }
      this.invalidateNode(input.loserId, {
        ts: input.ts,
        superseded_by: input.survivorId,
        session_id: input.session_id,
      });
    });
    return this.envelope(input.survivorId)!;
  }

  // Attribute enrichment apply: record the generated annotation for a node's
  // CURRENT revision and fold its searchable text into the FTS index — atomically, in the
  // daemon's write. The revision body is left EXACTLY as authored; only node_fts.content
  // gains the extra terms, so `get` is unchanged and recall widens. Guarded: skips if the
  // node vanished/was invalidated or advanced past `rev` since detection (the stale rev is
  // re-detected next sweep), and if an annotation for this rev already exists (idempotent).
  // Returns true when it enriched, false when it safely skipped. Never mutates a revision.
  applyAnnotation(input: {
    nodeId: string;
    rev: number;
    annotationsJson: string;
    ftsText: string;
    ts: string;
  }): boolean {
    return this.tx(() => {
      const row = enrichedById(this.db, input.nodeId);
      if (!row || row.invalidated_at || row.rev !== input.rev) return false;
      const exists = this.db
        .prepare("SELECT 1 FROM revision_annotations WHERE node_id = ? AND rev = ?")
        .get(input.nodeId, input.rev);
      if (exists) return false;
      this.db
        .prepare(
          "INSERT INTO revision_annotations (node_id, rev, annotations, ts) VALUES (?, ?, ?, ?)",
        )
        .run(input.nodeId, input.rev, input.annotationsJson, input.ts);
      const enriched = input.ftsText ? `${row.content}\n\n${input.ftsText}` : row.content;
      ftsPut(this.db, input.nodeId, row.title, enriched);
      return true;
    });
  }

  addRevision(
    id: string,
    fields: {
      content?: string;
      title?: string;
      session_id: string;
      reason: string | null;
      ts: string;
    },
  ): Envelope {
    this.tx(() => {
      const cur = this.db.prepare("SELECT title FROM nodes WHERE id = ?").get(id) as {
        title: string;
      };
      const nextRev =
        (
          this.db.prepare("SELECT MAX(rev) AS m FROM revisions WHERE node_id = ?").get(id) as {
            m: number;
          }
        ).m + 1;
      const content =
        fields.content ??
        (
          this.db
            .prepare("SELECT content FROM revisions WHERE node_id = ? AND rev = ?")
            .get(id, nextRev - 1) as {
            content: string;
          }
        ).content;
      const title = fields.title ?? cur.title;
      if (fields.title !== undefined) {
        this.db.prepare("UPDATE nodes SET title = ? WHERE id = ?").run(title, id);
      }
      insertRevision(this.db, id, nextRev, content, fields.session_id, fields.reason, fields.ts);
      ftsPut(this.db, id, title, content);
      syncChunks(this.db, id, nextRev, content, fields.ts);
    });
    return this.envelope(id)!;
  }

  // The event window, when one was claimed. Read by `get`; never folded into an envelope.
  eventWindow(id: string): { event_from: string | null; event_to: string | null } | undefined {
    return this.db.prepare("SELECT event_from, event_to FROM nodes WHERE id = ?").get(id) as
      { event_from: string | null; event_to: string | null } | undefined;
  }

  // Correct a node's event window. Facts of this shape get revised often ("it actually
  // started earlier"), and the window is node metadata, not content, so this is not a
  // revision. Only the keys passed are touched.
  setEventWindow(id: string, window: { event_from?: string; event_to?: string }): void {
    const sets: string[] = [];
    const params: Record<string, string> = { id };

    if (window.event_from !== undefined) {
      sets.push("event_from = @event_from");
      params.event_from = window.event_from;
    }

    if (window.event_to !== undefined) {
      sets.push("event_to = @event_to");
      params.event_to = window.event_to;
    }

    if (!sets.length) return;

    this.db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  // The node's state at an instant on the INGESTION axis: the revision that was current
  // then, or undefined if the node did not exist yet or had already been invalidated.
  // Answers "what did we believe on D", which is how a decision taken on stale information
  // gets audited. Note the title is not versioned, so only the body is historical.
  stateAt(id: string, asOf: string): { rev: number; content: string } | undefined {
    return this.db
      .prepare(
        `SELECT r.rev AS rev, r.content AS content FROM revisions r
         JOIN nodes n ON n.id = r.node_id
         WHERE r.node_id = @id AND r.ts <= @asOf
           AND n.created_at <= @asOf
           AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)
         ORDER BY r.rev DESC LIMIT 1`,
      )
      .get({ id, asOf }) as { rev: number; content: string } | undefined;
  }

  // The retrieval-outcome signal: an agent spent tokens fetching these nodes. Deliberately
  // does not touch the latest revision — usage is not an edit, and `updated` orders the
  // working set and breaks search ties.
  recordUse(ids: string[], ts: string): void {
    if (!ids.length) return;

    const ph = ids.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE nodes SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${ph})`)
      .run(ts, ...ids);
  }

  invalidateNode(
    id: string,
    fields: { ts: string; superseded_by?: string; session_id: string },
  ): Envelope {
    this.tx(() => {
      const { changes } = this.db
        .prepare("UPDATE nodes SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL")
        .run(fields.ts, id);
      if (changes && fields.superseded_by) {
        this.repointReferrers(id, fields.superseded_by, fields.session_id, fields.ts);
        this.edges.insertEdge(
          fields.superseded_by,
          id,
          EdgeType.SUPERSEDES,
          "agent",
          fields.session_id,
          fields.ts,
        );
      }
    });
    return this.envelope(id)!;
  }

  // Move everyone who pointed at a retired node onto its successor, so a referrer whose
  // last anchor was superseded stays in the graph. Only inbound edges: a node's outbound
  // edges are its own claims and retire with it. Only `agent` provenance, matching
  // `mergeNodes` — system `similar_to` edges are recomputed by the sweep, and re-pointing
  // one asserts a similarity nobody measured.
  // ⚠️ Must run BEFORE the `supersedes` edge is written, or it re-points that edge onto
  // the successor itself.
  private repointReferrers(id: string, successor: string, session_id: string, ts: string): void {
    const inbound = this.db
      .prepare(
        `SELECT src, type, weight FROM edges
          WHERE dst = @id AND invalidated_at IS NULL AND provenance = 'agent'`,
      )
      .all({ id }) as { src: string; type: string; weight: number }[];

    for (const e of inbound) {
      this.edges.invalidateEdge(e.src, id, e.type as EdgeType, ts);
      if (e.src === successor) continue; // self-loop after re-point -> drop
      this.edges.insertEdge(
        e.src,
        successor,
        e.type as EdgeType,
        "agent",
        session_id,
        ts,
        e.weight,
      );
    }
  }
}
