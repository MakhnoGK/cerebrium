import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import { BaseRepo, DB_TOKEN } from "@/db/repositories/base";
import { CodeRepo } from "@/db/repositories/code";
import { EmbeddingQueueRepo } from "@/db/repositories/embedding-queue";
import type { TechStats } from "@/core/types";

function walBytes(dbPath: string): number {
  if (dbPath === ":memory:" || !dbPath) return 0;
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

// Aggregate counters for the session working set (`stats`) and the deep operational
// snapshot (`techStats`). Composes the queue and code repos for their sub-counts.
@injectable()
export class StatsRepo extends BaseRepo {
  constructor(
    @inject(DB_TOKEN) db: Database.Database,
    private readonly queue: EmbeddingQueueRepo,
    private readonly code: CodeRepo,
  ) {
    super(db);
  }

  stats(): {
    nodes_by_kind: Record<string, number>;
    last_activity: string | null;
    embedding: { backlog: number; parked: number };
  } {
    const rows = this.db
      .prepare("SELECT memory_kind, COUNT(*) AS c FROM nodes GROUP BY memory_kind")
      .all() as { memory_kind: string; c: number }[];
    const nodes_by_kind: Record<string, number> = { episodic: 0, semantic: 0, mirror: 0 };
    for (const r of rows) nodes_by_kind[r.memory_kind] = r.c;
    const last = this.db.prepare("SELECT MAX(ts) AS t FROM events").get() as { t: string | null };
    return { nodes_by_kind, last_activity: last.t, embedding: this.queue.embeddingStats() };
  }

  dbPath(): string {
    return this.db.name;
  }

  // Deep operational snapshot for the `stats` tool + CLI. All cheap counts and
  // pragmas — no scan of node content. `now` is used only to decide whether the
  // embedding lease is currently held (drain is alive).
  techStats(now: string): TechStats {
    // A typed one-row query helper; the caller supplies the row shape at each call.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    const one = <T>(sql: string, ...params: unknown[]) => this.db.prepare(sql).get(...params) as T;

    const kindRows = this.db
      .prepare("SELECT memory_kind, COUNT(*) AS c FROM nodes GROUP BY memory_kind")
      .all() as { memory_kind: string; c: number }[];
    const nodes_by_kind: Record<string, number> = { episodic: 0, semantic: 0, mirror: 0 };
    let nodes_total = 0;
    for (const r of kindRows) {
      nodes_by_kind[r.memory_kind] = r.c;
      nodes_total += r.c;
    }

    const { backlog, parked } = this.queue.embeddingStats();
    const queueAgg = one<{ total: number; with_errors: number | null; oldest: string | null }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS with_errors,
              MIN(enqueued_at) AS oldest FROM embedding_queue`,
    );
    const histRows = this.db
      .prepare(
        "SELECT attempts, COUNT(*) AS c FROM embedding_queue GROUP BY attempts ORDER BY attempts",
      )
      .all() as { attempts: number; c: number }[];
    const attempts_histogram: Record<string, number> = {};
    for (const r of histRows) attempts_histogram[String(r.attempts)] = r.c;

    const edges = one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM edges WHERE invalidated_at IS NULL",
    ).c;
    const chunks_active = one<{ c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE stale = 0").c;
    const chunks_stale = one<{ c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE stale = 1").c;
    const chunks_embedded = one<{ c: number }>("SELECT COUNT(*) AS c FROM embedding_meta").c;
    const sessions = one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions").c;
    const events = one<{ c: number }>("SELECT COUNT(*) AS c FROM events").c;

    // Rerank usage from search-event telemetry: a search logs `reranked` only when it
    // reached the rerank-eligible path (hybrid/vector), so a present key = eligible.
    const rerankAgg = one<{
      eligible: number | null;
      reranked: number | null;
      candidates: number | null;
    }>(
      `SELECT SUM(CASE WHEN json_extract(detail, '$.reranked') IS NOT NULL THEN 1 ELSE 0 END) AS eligible,
              SUM(CASE WHEN json_extract(detail, '$.reranked') = 1 THEN 1 ELSE 0 END) AS reranked,
              COALESCE(SUM(json_extract(detail, '$.rerank_candidates')), 0) AS candidates
       FROM events WHERE action = 'search'`,
    );

    const page_count = Number(this.db.pragma("page_count", { simple: true })) || 0;
    const page_size = Number(this.db.pragma("page_size", { simple: true })) || 0;
    const db_path = this.db.name;

    const lease = this.db
      .prepare("SELECT owner, expires_at FROM worker_lease WHERE role = 'embedding'")
      .get() as { owner: string; expires_at: string } | undefined;

    return {
      queue: {
        backlog,
        parked,
        total: queueAgg.total,
        with_errors: queueAgg.with_errors ?? 0,
        oldest_enqueued_at: queueAgg.oldest,
        attempts_histogram,
      },
      content: {
        nodes_by_kind,
        nodes_total,
        edges,
        chunks_active,
        chunks_stale,
        chunks_embedded,
        chunks_unembedded: Math.max(0, chunks_active - chunks_embedded),
        sessions,
        events,
      },
      storage: {
        db_path,
        db_bytes: page_count * page_size,
        wal_bytes: walBytes(db_path),
        page_count,
        page_size,
      },
      drain: {
        lease_owner: lease?.owner ?? null,
        lease_expires_at: lease?.expires_at ?? null,
        lease_active: !!lease && lease.expires_at > now,
      },
      rerank_usage: {
        eligible_searches: rerankAgg.eligible ?? 0,
        reranked_searches: rerankAgg.reranked ?? 0,
        candidates_reranked: rerankAgg.candidates ?? 0,
      },
      code_repos: this.code.allRepoProvenance(),
      last_activity: one<{ t: string | null }>("SELECT MAX(ts) AS t FROM events").t,
    };
  }
}
