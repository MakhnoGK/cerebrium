import { injectable } from "tsyringe";
import type { Envelope, NeighborStub, NewNode, RevisionMeta } from "@cerebrium/contracts/types";
import { toEnvelope } from "@cerebrium/contracts/types";
import { EdgeType } from "@cerebrium/contracts/vocab";
import type { NodesRepo } from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import {
  edgesOf,
  enrichedById,
  insertEdge,
  insertRevision,
  invalidateEdge,
  invalidateSystemSimilaritiesOf,
  syncChunks,
  textPut,
} from "@/db/postgres/internal";
import { newId } from "@/core/ids";

@injectable()
export class PgNodesRepo extends PgBaseRepo implements NodesRepo {
  async exists(id: string): Promise<boolean> {
    return (await this.one("SELECT 1 FROM nodes WHERE id = @id", { id })) !== undefined;
  }

  async referenceState(id: string): Promise<"live" | "invalidated" | "missing"> {
    const row = await this.one<{ invalidated_at: string | null }>(
      "SELECT invalidated_at FROM nodes WHERE id = @id",
      { id },
    );

    if (!row) return "missing";

    return row.invalidated_at === null ? "live" : "invalidated";
  }

  async nodeOrigin(
    id: string,
  ): Promise<{ memory_kind: string; origin: string | null } | undefined> {
    return this.one("SELECT memory_kind, origin FROM nodes WHERE id = @id", { id });
  }

  async envelope(id: string): Promise<Envelope | undefined> {
    const row = await enrichedById(this.db, id);

    return row ? toEnvelope(row) : undefined;
  }

  async fullNode(
    id: string,
  ): Promise<{ envelope: Envelope; content: string; edges: NeighborStub[] } | undefined> {
    const row = await enrichedById(this.db, id);

    if (!row) return undefined;

    return { envelope: toEnvelope(row), content: row.content, edges: await edgesOf(this.db, id) };
  }

  async listRevisions(id: string): Promise<RevisionMeta[]> {
    return this.all<RevisionMeta>(
      "SELECT rev, ts, session_id, reason FROM revisions WHERE node_id = @id ORDER BY rev",
      { id },
    );
  }

  async revisionContent(id: string, rev: number): Promise<string | undefined> {
    return (
      await this.one<{ content: string }>(
        "SELECT content FROM revisions WHERE node_id = @id AND rev = @rev",
        { id, rev },
      )
    )?.content;
  }

  async createNode(input: NewNode): Promise<Envelope> {
    const id = newId();

    await this.tx(async () => {
      await this.db.query(
        `INSERT INTO nodes (id, memory_kind, type, title, project, valid_from, created_by_session, created_at, event_from, event_to)
         VALUES (@id, @kind, @type, @title, @project, @ts, @session, @ts, @eventFrom, @eventTo)`,
        {
          id,
          kind: input.memory_kind,
          type: input.type,
          title: input.title,
          project: input.project,
          ts: input.ts,
          session: input.session_id,
          eventFrom: input.event_from ?? null,
          eventTo: input.event_to ?? null,
        },
      );
      await insertRevision(this.db, id, 1, input.content, input.session_id, null, input.ts);
      await textPut(this.db, id, input.title, input.content);
      await syncChunks(this.db, id, 1, input.content, input.ts);

      for (const link of input.links ?? []) {
        await insertEdge(this.db, id, link.dst, link.type, "agent", input.session_id, input.ts);
      }
    });

    return (await this.envelope(id))!;
  }

  async applyDistillation(input: {
    title: string;
    content: string;
    project: string | null;
    sourceIds: string[];
    session_id: string;
    ts: string;
  }): Promise<Envelope> {
    const id = newId();

    await this.tx(async () => {
      await this.db.query(
        `INSERT INTO nodes (id, memory_kind, type, title, project, valid_from, created_by_session, created_at)
         VALUES (@id, 'semantic', 'fact', @title, @project, @ts, @session, @ts)`,
        {
          id,
          title: input.title,
          project: input.project,
          ts: input.ts,
          session: input.session_id,
        },
      );
      await insertRevision(this.db, id, 1, input.content, input.session_id, null, input.ts);
      await textPut(this.db, id, input.title, input.content);
      await syncChunks(this.db, id, 1, input.content, input.ts);

      for (const src of input.sourceIds) {
        await insertEdge(
          this.db,
          id,
          src,
          EdgeType.DERIVED_FROM,
          "system",
          input.session_id,
          input.ts,
        );
        await this.db.query(
          `UPDATE nodes SET consolidated_at = @ts
           WHERE id = @src AND memory_kind = 'episodic' AND consolidated_at IS NULL`,
          { ts: input.ts, src },
        );
      }
    });

    return (await this.envelope(id))!;
  }

  async applyMerge(input: {
    survivorId: string;
    loserId: string;
    session_id: string;
    ts: string;
    merged?: { title: string; body: string };
  }): Promise<Envelope | undefined> {
    const applied = await this.tx(async () => {
      const live = await this.one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM nodes
         WHERE id IN (@survivor, @loser) AND invalidated_at IS NULL`,
        { survivor: input.survivorId, loser: input.loserId },
      );

      if (live?.count !== 2) return false;

      if (input.merged) {
        await this.revise(input.survivorId, {
          content: input.merged.body,
          title: input.merged.title,
          session_id: input.session_id,
          reason: "merge",
          ts: input.ts,
        });
      }

      const incident = await this.all<{ src: string; dst: string; type: string; weight: number }>(
        `SELECT src, dst, type, weight FROM edges
         WHERE invalidated_at IS NULL AND provenance = 'agent' AND (src = @loser OR dst = @loser)`,
        { loser: input.loserId },
      );

      for (const e of incident) {
        await this.db.query(
          "UPDATE edges SET invalidated_at = @ts WHERE src = @src AND dst = @dst AND type = @type",
          { ts: input.ts, src: e.src, dst: e.dst, type: e.type },
        );

        const nsrc = e.src === input.loserId ? input.survivorId : e.src;
        const ndst = e.dst === input.loserId ? input.survivorId : e.dst;

        if (nsrc === ndst) continue;

        await insertEdge(
          this.db,
          nsrc,
          ndst,
          e.type as EdgeType,
          "agent",
          input.session_id,
          input.ts,
          e.weight,
        );
      }

      await this.retire(input.loserId, {
        ts: input.ts,
        superseded_by: input.survivorId,
        session_id: input.session_id,
      });

      return true;
    });

    return applied ? (await this.envelope(input.survivorId))! : undefined;
  }

  async applyAnnotation(input: {
    nodeId: string;
    rev: number;
    annotationsJson: string;
    ftsText: string;
    ts: string;
  }): Promise<boolean> {
    return this.tx(async () => {
      const row = await enrichedById(this.db, input.nodeId);

      if (!row || row.invalidated_at || row.rev !== input.rev) return false;

      const exists = await this.one(
        "SELECT 1 FROM revision_annotations WHERE node_id = @id AND rev = @rev",
        { id: input.nodeId, rev: input.rev },
      );

      if (exists) return false;

      await this.db.query(
        `INSERT INTO revision_annotations (node_id, rev, annotations, ts)
         VALUES (@id, @rev, @annotations, @ts)`,
        { id: input.nodeId, rev: input.rev, annotations: input.annotationsJson, ts: input.ts },
      );

      const enriched = input.ftsText ? `${row.content}\n\n${input.ftsText}` : row.content;

      await textPut(this.db, input.nodeId, row.title, enriched);

      return true;
    });
  }

  async addRevision(
    id: string,
    fields: {
      content?: string;
      title?: string;
      session_id: string;
      reason: string | null;
      ts: string;
    },
  ): Promise<Envelope> {
    await this.revise(id, fields);

    return (await this.envelope(id))!;
  }

  private async revise(
    id: string,
    fields: {
      content?: string;
      title?: string;
      session_id: string;
      reason: string | null;
      ts: string;
    },
  ): Promise<void> {
    await this.tx(async () => {
      const cur = await this.one<{ title: string }>("SELECT title FROM nodes WHERE id = @id", {
        id,
      });
      const last = await this.one<{ rev: number; content: string }>(
        "SELECT rev, content FROM revisions WHERE node_id = @id ORDER BY rev DESC LIMIT 1",
        { id },
      );

      if (!cur || !last) throw new Error(`cannot revise missing node ${id}`);

      const nextRev = last.rev + 1;
      const content = fields.content ?? last.content;
      const title = fields.title ?? cur.title;

      if (fields.title !== undefined) {
        await this.db.query("UPDATE nodes SET title = @title WHERE id = @id", { title, id });
      }

      await insertRevision(
        this.db,
        id,
        nextRev,
        content,
        fields.session_id,
        fields.reason,
        fields.ts,
      );
      await textPut(this.db, id, title, content);
      await syncChunks(this.db, id, nextRev, content, fields.ts);
    });
  }

  async eventWindow(
    id: string,
  ): Promise<{ event_from: string | null; event_to: string | null } | undefined> {
    return this.one("SELECT event_from, event_to FROM nodes WHERE id = @id", { id });
  }

  async setEventWindow(
    id: string,
    window: { event_from?: string; event_to?: string },
  ): Promise<void> {
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

    await this.run(`UPDATE nodes SET ${sets.join(", ")} WHERE id = @id`, params);
  }

  async stateAt(id: string, asOf: string): Promise<{ rev: number; content: string } | undefined> {
    return this.one(
      `SELECT r.rev AS rev, r.content AS content FROM revisions r
       JOIN nodes n ON n.id = r.node_id
       WHERE r.node_id = @id AND r.ts <= @asOf
         AND n.created_at <= @asOf
         AND (n.invalidated_at IS NULL OR n.invalidated_at > @asOf)
       ORDER BY r.rev DESC LIMIT 1`,
      { id, asOf },
    );
  }

  async principalsOf(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();

    const rows = await this.all<{ id: string; principal: string }>(
      `SELECT n.id AS id, s.principal_id AS principal
         FROM nodes n JOIN sessions s ON s.id = n.created_by_session
        WHERE n.id = ANY(@ids) AND n.memory_kind IN ('semantic','episodic')
          AND s.principal_id IS NOT NULL`,
      { ids },
    );

    return new Map(rows.map((row) => [row.id, row.principal]));
  }

  async recordUse(ids: string[], ts: string): Promise<void> {
    if (!ids.length) return;

    await this.run(
      "UPDATE nodes SET use_count = use_count + 1, last_used_at = @ts WHERE id = ANY(@ids)",
      { ts, ids },
    );
  }

  async invalidateNode(
    id: string,
    fields: { ts: string; superseded_by?: string; session_id: string },
  ): Promise<Envelope> {
    await this.retire(id, fields);

    return (await this.envelope(id))!;
  }

  private async retire(
    id: string,
    fields: { ts: string; superseded_by?: string; session_id: string },
  ): Promise<void> {
    await this.tx(async () => {
      const changes =
        (
          await this.db.query(
            "UPDATE nodes SET invalidated_at = @ts WHERE id = @id AND invalidated_at IS NULL",
            { ts: fields.ts, id },
          )
        ).rowCount ?? 0;

      if (changes) {
        await invalidateSystemSimilaritiesOf(this.db, id, fields.ts);
      }

      if (changes && fields.superseded_by) {
        await this.repointReferrers(id, fields.superseded_by, fields.session_id, fields.ts);
        await insertEdge(
          this.db,
          fields.superseded_by,
          id,
          EdgeType.SUPERSEDES,
          "agent",
          fields.session_id,
          fields.ts,
        );
      }
    });
  }

  async restoreNode(id: string, fields: { ts: string; session_id: string }): Promise<boolean> {
    return this.tx(async () => {
      const changes =
        (
          await this.db.query(
            "UPDATE nodes SET invalidated_at = NULL WHERE id = @id AND invalidated_at IS NOT NULL",
            { id },
          )
        ).rowCount ?? 0;

      if (!changes) return false;

      const supersedes = await this.all<{ src: string }>(
        "SELECT src FROM edges WHERE dst = @id AND type = @type AND invalidated_at IS NULL",
        { id, type: EdgeType.SUPERSEDES },
      );

      for (const e of supersedes) {
        await invalidateEdge(this.db, e.src, id, EdgeType.SUPERSEDES, fields.ts);
      }

      return true;
    });
  }

  // ⚠️ Must run BEFORE the `supersedes` edge is written, or it re-points that edge onto
  // the successor itself.
  private async repointReferrers(
    id: string,
    successor: string,
    session_id: string,
    ts: string,
  ): Promise<void> {
    const inbound = await this.all<{ src: string; type: string; weight: number }>(
      `SELECT src, type, weight FROM edges
        WHERE dst = @id AND invalidated_at IS NULL AND provenance = 'agent'`,
      { id },
    );

    for (const e of inbound) {
      await invalidateEdge(this.db, e.src, id, e.type as EdgeType, ts);

      if (e.src === successor) continue;

      await insertEdge(
        this.db,
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
