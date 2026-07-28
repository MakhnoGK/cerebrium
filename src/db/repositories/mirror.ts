import { createHash } from "node:crypto";
import { injectable } from "tsyringe";
import { BaseRepo } from "@/db/repositories/base";
import { ftsPut, insertRevision, syncChunks } from "@/db/repositories/internal";
import { newId } from "@/core/ids";
import type {
  MirrorItem,
  MirrorRecord,
  MirrorSource,
  MirrorSourceStatus,
  MirrorUpsertResult,
} from "@/core/types";

// The external-mirror aggregate: the per-deployment source registry and
// the agent-driven, curated upsert of `mirror` nodes whose origin != 'repo'. Mirror
// writes reuse the shared node-write primitives (revision + FTS + chunk/queue) exactly
// like the code mirror; the kernel never fetches from an external service — the agent
// supplies already-fetched records through the tool layer.

const SOURCE_COLS =
  "id, kind, label, project, freshness_hours, recipe, enabled, last_synced_at, registered_at";

interface SourceRow {
  id: string;
  kind: string;
  label: string | null;
  project: string | null;
  freshness_hours: number | null;
  recipe: string | null;
  enabled: number;
  last_synced_at: string | null;
  registered_at: string;
}

function toSource(r: SourceRow): MirrorSource {
  return { ...r, enabled: !!r.enabled };
}

// Stable upsert key for an external mirror node — content-addressed on the source
// instance + the source's own id, so re-syncing the same record hits the same node.
export function mirrorExternalId(sourceId: string, nativeId: string): string {
  return createHash("sha256").update(`${sourceId}\0${nativeId}`).digest("hex").slice(0, 24);
}

@injectable()
export class MirrorRepo extends BaseRepo {
  // ---- source registry -----------------------------------------------------

  registerSource(input: {
    id: string;
    kind: string;
    label?: string | null;
    project?: string | null;
    freshness_hours?: number | null;
    recipe?: string | null;
    enabled?: boolean;
    ts: string;
  }): MirrorSource {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO mirror_sources
             (id, kind, label, project, freshness_hours, recipe, enabled, registered_at, invalidated_at)
           VALUES (@id, @kind, @label, @project, @freshness_hours, @recipe, @enabled, @ts, NULL)
           ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label,
             project = excluded.project, freshness_hours = excluded.freshness_hours,
             recipe = excluded.recipe, enabled = excluded.enabled, invalidated_at = NULL`,
        )
        .run({
          id: input.id,
          kind: input.kind,
          label: input.label ?? null,
          project: input.project ?? null,
          freshness_hours: input.freshness_hours ?? null,
          recipe: input.recipe ?? null,
          enabled: (input.enabled ?? true) ? 1 : 0,
          ts: input.ts,
        });
    });
    return this.getSource(input.id)!;
  }

  getSource(id: string): MirrorSource | undefined {
    const r = this.db
      .prepare(`SELECT ${SOURCE_COLS} FROM mirror_sources WHERE id = ? AND invalidated_at IS NULL`)
      .get(id) as SourceRow | undefined;
    return r ? toSource(r) : undefined;
  }

  listSources(): MirrorSource[] {
    return (
      this.db
        .prepare(
          `SELECT ${SOURCE_COLS} FROM mirror_sources WHERE invalidated_at IS NULL ORDER BY id`,
        )
        .all() as SourceRow[]
    ).map(toSource);
  }

  // Registered sources plus computed freshness + live node count. `id` narrows to one.
  sourceStatus(now: string, id?: string): MirrorSourceStatus[] {
    const sources = id
      ? [this.getSource(id)].filter((s): s is MirrorSource => s !== undefined)
      : this.listSources();
    const nowMs = Date.parse(now);
    const countStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM mirror_records r JOIN nodes n ON n.id = r.node_id
       WHERE r.source_id = ? AND n.invalidated_at IS NULL`,
    );
    return sources.map((s) => {
      const node_count = (countStmt.get(s.id) as { c: number }).c;
      const hours_stale =
        s.last_synced_at != null ? (nowMs - Date.parse(s.last_synced_at)) / 3_600_000 : null;
      const stale =
        s.enabled &&
        s.freshness_hours != null &&
        (hours_stale === null || hours_stale > s.freshness_hours);
      return { ...s, hours_stale, stale, node_count };
    });
  }

  // ---- mirror node upsert (curated, agent-driven) --------------------------

  private writeRecord(nodeId: string, sourceId: string, item: MirrorItem): void {
    this.db
      .prepare(
        `INSERT INTO mirror_records (node_id, source_id, native_id, url, facets)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET url = excluded.url, facets = excluded.facets`,
      )
      .run(
        nodeId,
        sourceId,
        item.native_id,
        item.url ?? null,
        item.facets !== undefined ? JSON.stringify(item.facets) : null,
      );
  }

  private insertMirrorNode(
    source: MirrorSource,
    item: MirrorItem,
    externalId: string,
    project: string | null,
    session_id: string,
    ts: string,
  ): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO nodes (id, memory_kind, type, title, project, origin, external_id, synced_at,
                            valid_from, created_by_session, created_at)
         VALUES (?, 'mirror', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, item.type, item.title, project, source.kind, externalId, ts, ts, session_id, ts);
    insertRevision(this.db, id, 1, item.content, session_id, null, ts);
    ftsPut(this.db, id, item.title, item.content);
    syncChunks(this.db, id, 1, item.content, ts);
    this.writeRecord(id, source.id, item);
    return id;
  }

  private reviseMirrorNode(nodeId: string, item: MirrorItem, session_id: string, ts: string): void {
    const nextRev =
      (
        this.db.prepare("SELECT MAX(rev) AS m FROM revisions WHERE node_id = ?").get(nodeId) as {
          m: number;
        }
      ).m + 1;
    insertRevision(this.db, nodeId, nextRev, item.content, session_id, "re-sync", ts);
    ftsPut(this.db, nodeId, item.title, item.content);
    syncChunks(this.db, nodeId, nextRev, item.content, ts);
    // Revive a record the agent had retired and that reappeared; refresh title + stamp.
    this.db
      .prepare(
        "UPDATE nodes SET title = ?, type = ?, invalidated_at = NULL, synced_at = ? WHERE id = ?",
      )
      .run(item.title, item.type, ts, nodeId);
  }

  // Curated batch upsert. One transaction per item so a mid-batch crash leaves a
  // consistent partial result. Idempotent by (source, native_id): unchanged content
  // is a no-op (no new revision, no re-embed); url/facets are always refreshed cheaply.
  // Never invalidates records absent from the batch — the agent curates a subset, so
  // removal is explicit (via `invalidate`), unlike the code index's whole-file sweep.
  upsertMirrors(
    source: MirrorSource,
    items: MirrorItem[],
    session_id: string,
    ts: string,
  ): MirrorUpsertResult {
    const result: MirrorUpsertResult = {
      source_id: source.id,
      added: 0,
      updated: 0,
      unchanged: 0,
      node_ids: [],
    };
    for (const item of items) {
      const externalId = mirrorExternalId(source.id, item.native_id);
      const project = item.project ?? source.project ?? null;
      this.tx(() => {
        const prior = this.db
          .prepare(
            `SELECT n.id AS id, n.title AS title, n.invalidated_at AS invalidated_at, lr.content AS content
             FROM nodes n
             JOIN (SELECT node_id, MAX(rev) AS mrev FROM revisions GROUP BY node_id) m ON m.node_id = n.id
             JOIN revisions lr ON lr.node_id = n.id AND lr.rev = m.mrev
             WHERE n.external_id = ? AND n.memory_kind = 'mirror' AND n.origin = ?`,
          )
          .get(externalId, source.kind) as
          { id: string; title: string; invalidated_at: string | null; content: string } | undefined;

        if (!prior) {
          const id = this.insertMirrorNode(source, item, externalId, project, session_id, ts);
          result.added++;
          result.node_ids.push(id);
          return;
        }
        const changed =
          prior.content !== item.content ||
          prior.title !== item.title ||
          prior.invalidated_at != null;
        if (changed) {
          this.reviseMirrorNode(prior.id, item, session_id, ts);
          result.updated++;
        } else {
          result.unchanged++;
        }
        this.writeRecord(prior.id, source.id, item);
        result.node_ids.push(prior.id);
      });
    }
    this.tx(() => {
      this.db
        .prepare("UPDATE mirror_sources SET last_synced_at = ? WHERE id = ?")
        .run(ts, source.id);
    });
    return result;
  }

  // ---- reads for get / invalidate guard ------------------------------------

  mirrorRecord(nodeId: string): MirrorRecord | undefined {
    const r = this.db
      .prepare("SELECT source_id, native_id, url, facets FROM mirror_records WHERE node_id = ?")
      .get(nodeId) as
      | { source_id: string; native_id: string; url: string | null; facets: string | null }
      | undefined;
    if (!r) return undefined;
    return {
      source_id: r.source_id,
      native_id: r.native_id,
      url: r.url,
      facets: r.facets != null ? (JSON.parse(r.facets) as Record<string, unknown>) : null,
    };
  }
}
