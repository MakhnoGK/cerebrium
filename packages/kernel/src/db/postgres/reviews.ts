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
import { PgBaseRepo } from "@/db/postgres/base";

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

// Pending is derived: the artifact is live, its author is in scope, and no decision row
// names it. See db/sqlite/reviews.ts.
@injectable()
export class PgReviewsRepo extends PgBaseRepo implements ReviewsRepo {
  private scopeClause(scope: ReviewScope, column: string): { sql: string; principals: string[] } {
    const principals = [...scope.principals];

    if (scope.mode === "only") {
      if (!principals.length) return { sql: "FALSE", principals };

      return { sql: `${column} = ANY(@principals)`, principals };
    }

    if (!principals.length) return { sql: "TRUE", principals };

    return { sql: `(${column} IS NULL OR NOT (${column} = ANY(@principals)))`, principals };
  }

  private static readonly PENDING_EDGES = `
    FROM edges e
    JOIN sessions s ON s.id = e.session_id
    LEFT JOIN review_decisions rd
      ON rd.artifact_kind = 'edge'
     AND rd.artifact_ref = e.src || '|' || e.dst || '|' || e.type
    WHERE e.invalidated_at IS NULL
      AND e.provenance = 'agent'
      AND rd.artifact_ref IS NULL`;

  private static readonly PENDING_NODES = `
    FROM nodes n
    JOIN sessions s ON s.id = n.created_by_session
    LEFT JOIN review_decisions rd
      ON rd.artifact_kind = 'node' AND rd.artifact_ref = n.id
    WHERE n.invalidated_at IS NULL
      AND n.memory_kind IN (@semantic, @episodic)
      AND rd.artifact_ref IS NULL`;

  async pendingEdges(scope: ReviewScope, limit: number): Promise<PendingEdge[]> {
    const { sql, principals } = this.scopeClause(scope, "s.principal_id");

    const rows = await this.all<EdgeRow>(
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
        ORDER BY e.valid_from DESC, e.src, e.dst, e.type
        LIMIT @limit`,
      { principals, limit },
    );

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
    const { sql, principals } = this.scopeClause(scope, "s.principal_id");

    const rows = await this.all<NodeRow>(
      `SELECT n.id AS id, n.type AS type, n.title AS title, n.created_at AS at,
              s.principal_id AS principal
         ${PgReviewsRepo.PENDING_NODES}
          AND ${sql}
        ORDER BY n.created_at DESC, n.id
        LIMIT @limit`,
      {
        semantic: MemoryKind.SEMANTIC,
        episodic: MemoryKind.EPISODIC,
        principals,
        limit,
      },
    );

    return rows.map((r) => ({
      ref: r.id,
      at: r.at,
      principal: r.principal,
      node: { id: r.id, type: r.type, title: r.title },
    }));
  }

  async pendingCount(scope: ReviewScope): Promise<{ edges: number; nodes: number }> {
    const { sql, principals } = this.scopeClause(scope, "s.principal_id");

    const row = await this.one<{ edges: number; nodes: number }>(
      `SELECT
         (SELECT COUNT(*) ${PgReviewsRepo.PENDING_EDGES} AND ${sql}) AS edges,
         (SELECT COUNT(*) ${PgReviewsRepo.PENDING_NODES} AND ${sql}) AS nodes`,
      { semantic: MemoryKind.SEMANTIC, episodic: MemoryKind.EPISODIC, principals },
    );

    return { edges: row?.edges ?? 0, nodes: row?.nodes ?? 0 };
  }

  async decisionFor(artifact: ReviewArtifact, ref: string): Promise<RecordedDecision | null> {
    const row = await this.one<{
      artifact_kind: string;
      artifact_ref: string;
      decision: string;
      decided_at: string;
      decided_by: string | null;
      note: string | null;
    }>(
      `SELECT artifact_kind, artifact_ref, decision, decided_at, decided_by, note
         FROM review_decisions WHERE artifact_kind = @artifact AND artifact_ref = @ref`,
      { artifact, ref },
    );

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
    await this.run(
      `INSERT INTO review_decisions
         (artifact_kind, artifact_ref, decision, decided_at, decided_by, note)
       VALUES (@artifact, @ref, @decision, @decided_at, @decided_by, @note)
       ON CONFLICT (artifact_kind, artifact_ref) DO UPDATE SET
         decision = excluded.decision,
         decided_at = excluded.decided_at,
         decided_by = excluded.decided_by,
         note = excluded.note`,
      { ...entry },
    );
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.all<{ decision: string; n: number }>(
      "SELECT decision, COUNT(*) AS n FROM review_decisions GROUP BY decision",
    );

    return Object.fromEntries(rows.map((r) => [r.decision, r.n]));
  }
}
