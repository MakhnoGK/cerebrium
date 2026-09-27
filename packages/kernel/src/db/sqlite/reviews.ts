import { injectable } from "tsyringe";
import { MemoryKind, ReviewArtifact, type ReviewDecision } from "@cerebrium/contracts/vocab";
import {
  edgeRef,
  type PendingEdge,
  type PendingNode,
  type RecordedDecision,
  type ReviewScope,
  type ReviewsRepo,
} from "@/domain/ports/storage";
import { BaseRepo } from "@/db/sqlite/base";

interface EdgeRow {
  src: string;
  dst: string;
  edge_type: string;
  at: string;
  principal: string | null;
  src_type: string;
  src_title: string;
  dst_type: string;
  dst_title: string;
}

interface NodeRow {
  id: string;
  type: string;
  title: string;
  at: string;
  principal: string | null;
}

// The queue of writes that landed under a `suggest` posture and nobody has judged yet.
//
// It is derived, not maintained: pending is "the artifact is live, its author is in scope,
// and no decision row names it". Nothing has to be enqueued when a write happens, so a
// posture flipped on after the fact still surfaces what came before it.
@injectable()
export class SqliteReviewsRepo extends BaseRepo implements ReviewsRepo {
  private scopeClause(scope: ReviewScope, column: string): { sql: string; params: string[] } {
    const list = [...scope.principals];

    if (scope.mode === "only") {
      // Nothing named means nothing is under review, which must select no rows rather than
      // degenerate into an always-true `NOT IN ()`.
      if (!list.length) return { sql: "0", params: [] };

      return { sql: `${column} IN (${list.map(() => "?").join(", ")})`, params: list };
    }

    if (!list.length) return { sql: "1", params: [] };

    return {
      sql: `(${column} IS NULL OR ${column} NOT IN (${list.map(() => "?").join(", ")}))`,
      params: list,
    };
  }

  async pendingEdges(scope: ReviewScope, limit: number): Promise<PendingEdge[]> {
    const { sql, params } = this.scopeClause(scope, "s.principal_id");

    const rows = this.db
      .prepare(
        `SELECT e.src AS src, e.dst AS dst, e.type AS edge_type, e.valid_from AS at,
                s.principal_id AS principal,
                ns.type AS src_type, ns.title AS src_title,
                nd.type AS dst_type, nd.title AS dst_title
           FROM edges e
           JOIN sessions s ON s.id = e.session_id
           JOIN nodes ns ON ns.id = e.src
           JOIN nodes nd ON nd.id = e.dst
           LEFT JOIN review_decisions rd
             ON rd.artifact_kind = 'edge'
            AND rd.artifact_ref = e.src || '|' || e.dst || '|' || e.type
          WHERE e.invalidated_at IS NULL
            AND e.provenance = 'agent'
            AND rd.artifact_ref IS NULL
            AND ${sql}
          ORDER BY e.valid_from DESC
          LIMIT ?`,
      )
      .all(...params, limit) as EdgeRow[];

    return rows.map((r) => ({
      ref: edgeRef(r.src, r.dst, r.edge_type),
      edge_type: r.edge_type,
      at: r.at,
      principal: r.principal,
      src: { id: r.src, type: r.src_type, title: r.src_title },
      dst: { id: r.dst, type: r.dst_type, title: r.dst_title },
    }));
  }

  async pendingNodes(scope: ReviewScope, limit: number): Promise<PendingNode[]> {
    const { sql, params } = this.scopeClause(scope, "s.principal_id");

    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.type AS type, n.title AS title, n.created_at AS at,
                s.principal_id AS principal
           FROM nodes n
           JOIN sessions s ON s.id = n.created_by_session
           LEFT JOIN review_decisions rd
             ON rd.artifact_kind = 'node' AND rd.artifact_ref = n.id
          WHERE n.invalidated_at IS NULL
            AND n.memory_kind IN (?, ?)
            AND rd.artifact_ref IS NULL
            AND ${sql}
          ORDER BY n.created_at DESC
          LIMIT ?`,
      )
      .all(MemoryKind.SEMANTIC, MemoryKind.EPISODIC, ...params, limit) as NodeRow[];

    return rows.map((r) => ({
      ref: r.id,
      at: r.at,
      principal: r.principal,
      node: { id: r.id, type: r.type, title: r.title },
    }));
  }

  // One statement rather than two round trips: this is asked for on every tool call that
  // renders session hints.
  async pendingCount(scope: ReviewScope): Promise<{ edges: number; nodes: number }> {
    const { sql, params } = this.scopeClause(scope, "s.principal_id");

    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*)
              FROM edges e
              JOIN sessions s ON s.id = e.session_id
              LEFT JOIN review_decisions rd
                ON rd.artifact_kind = 'edge'
               AND rd.artifact_ref = e.src || '|' || e.dst || '|' || e.type
             WHERE e.invalidated_at IS NULL
               AND e.provenance = 'agent'
               AND rd.artifact_ref IS NULL
               AND ${sql}) AS edges,
           (SELECT COUNT(*)
              FROM nodes n
              JOIN sessions s ON s.id = n.created_by_session
              LEFT JOIN review_decisions rd
                ON rd.artifact_kind = 'node' AND rd.artifact_ref = n.id
             WHERE n.invalidated_at IS NULL
               AND n.memory_kind IN (?, ?)
               AND rd.artifact_ref IS NULL
               AND ${sql}) AS nodes`,
      )
      .get(...params, MemoryKind.SEMANTIC, MemoryKind.EPISODIC, ...params) as {
      edges: number;
      nodes: number;
    };

    return { edges: row.edges, nodes: row.nodes };
  }

  async decisionFor(artifact: ReviewArtifact, ref: string): Promise<RecordedDecision | null> {
    const row = this.db
      .prepare(
        `SELECT artifact_kind, artifact_ref, decision, decided_at, decided_by, note
           FROM review_decisions WHERE artifact_kind = ? AND artifact_ref = ?`,
      )
      .get(artifact, ref) as
      | {
          artifact_kind: string;
          artifact_ref: string;
          decision: string;
          decided_at: string;
          decided_by: string | null;
          note: string | null;
        }
      | undefined;

    return row === undefined
      ? null
      : {
          artifact: row.artifact_kind as ReviewArtifact,
          ref: row.artifact_ref,
          decision: row.decision as ReviewDecision,
          decided_at: row.decided_at,
          decided_by: row.decided_by,
          note: row.note,
        };
  }

  async record(entry: RecordedDecision): Promise<void> {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO review_decisions
             (artifact_kind, artifact_ref, decision, decided_at, decided_by, note)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (artifact_kind, artifact_ref) DO UPDATE SET
             decision = excluded.decision,
             decided_at = excluded.decided_at,
             decided_by = excluded.decided_by,
             note = excluded.note`,
        )
        .run(
          entry.artifact,
          entry.ref,
          entry.decision,
          entry.decided_at,
          entry.decided_by,
          entry.note,
        );
    });
  }

  async counts(): Promise<Record<string, number>> {
    const rows = this.db
      .prepare("SELECT decision, COUNT(*) n FROM review_decisions GROUP BY decision")
      .all() as { decision: string; n: number }[];

    return Object.fromEntries(rows.map((r) => [r.decision, r.n]));
  }
}
