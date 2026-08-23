import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { inject, injectable } from "tsyringe";
import { BaseRepo, DB_TOKEN } from "@/db/repositories/base";
import { CodeRepo } from "@/db/repositories/code";
import { EmbeddingQueueRepo } from "@/db/repositories/embedding-queue";
import { JobsRepo } from "@/db/repositories/jobs";
import type { TechStats } from "@/core/types";
import { EdgeType, JobKind, MemoryKind } from "@/core/vocab";

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
    private readonly jobs: JobsRepo,
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
    const vectors_authored = one<{ c: number }>("SELECT COUNT(*) AS c FROM chunk_vec").c;
    const vectors_code = one<{ c: number }>("SELECT COUNT(*) AS c FROM code_vec").c;
    const sessions = one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions").c;
    const events = one<{ c: number }>("SELECT COUNT(*) AS c FROM events").c;

    const graph = this.graphHealth();

    const page_count = Number(this.db.pragma("page_count", { simple: true })) || 0;
    const page_size = Number(this.db.pragma("page_size", { simple: true })) || 0;
    const db_path = this.db.name;

    const lease = this.db
      .prepare("SELECT owner, expires_at FROM worker_lease WHERE role = 'embedding'")
      .get() as { owner: string; expires_at: string } | undefined;

    // The sweep lease, not an open run row: a row stays open when the process holding it
    // is killed, so "is a sweep running" has to be asked of something that expires.
    const sweepLease = this.db
      .prepare("SELECT owner, expires_at FROM worker_lease WHERE role = 'consolidation'")
      .get() as { owner: string; expires_at: string } | undefined;

    const candStats = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
           SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
         FROM consolidation_candidates`,
      )
      .get() as { pending: number | null; applied: number | null; dismissed: number | null };

    const runCount = this.db.prepare(`SELECT COUNT(*) AS total FROM consolidation_runs`).get() as {
      total: number;
    };

    const lastRun = this.db
      .prepare(
        `SELECT started_at, stage, last_error FROM consolidation_runs ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { started_at: string; stage: string | null; last_error: string | null } | undefined;

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
        chunks_unembedded: one<{ c: number }>(
          "SELECT COUNT(*) AS c FROM chunks c WHERE c.stale = 0 AND NOT EXISTS (SELECT 1 FROM embedding_meta m WHERE m.chunk_id = c.id)",
        ).c,
        vectors_authored,
        vectors_code,
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
      graph,
      consolidation: {
        pending: candStats.pending ?? 0,
        applied: candStats.applied ?? 0,
        dismissed: candStats.dismissed ?? 0,
        runs_total: runCount.total,
        last_run_at: lastRun?.started_at ?? null,
        last_error: lastRun?.last_error ?? null,
        last_stage: lastRun?.stage ?? null,
        sweep_running: !!sweepLease && sweepLease.expires_at > now,
        sweep_lease_owner: sweepLease?.owner ?? null,
        sweep_lease_expires_at: sweepLease?.expires_at ?? null,
      },
      jobs: this.jobStats(),
      code_repos: this.code.allRepoProvenance(),
      last_activity: one<{ t: string | null }>("SELECT MAX(ts) AS t FROM events").t,
    };
  }

  private jobStats(): TechStats["jobs"] {
    const [last] = this.jobs.recent({ kind: JobKind.CODE_INDEX, limit: 1 });

    return {
      by_state: this.jobs.counts(),
      last_code_index_at: last?.ended_at ?? null,
      last_code_index_error: last?.last_error ?? null,
      code_index_open: this.jobs.hasOpen(JobKind.CODE_INDEX),
    };
  }

  // Integrity of the authored graph: edges left pointing at soft-deleted nodes, and
  // nodes those edges have stranded. Mirrors are excluded — the indexer owns them and
  // rebuilds their edges wholesale. `supersedes` is excluded because an edge into a
  // soft-deleted node is exactly what it is for.
  // ⚠️ `memory_kind IN (...)` rather than `!= 'mirror'`: only the IN form can drive
  // idx_nodes_kind_type, and the difference is 213 indexed rows against a 125k scan.
  private graphHealth(): TechStats["graph"] {
    const authored = [MemoryKind.SEMANTIC, MemoryKind.EPISODIC];

    const dangling = this.db
      .prepare(
        `SELECT COUNT(*) AS all_edges,
                SUM(CASE WHEN e.provenance = 'agent' AND EXISTS (
                      SELECT 1 FROM edges s JOIN nodes sn ON sn.id = s.src
                       WHERE s.dst = nd.id AND s.type = @supersedes
                         AND s.invalidated_at IS NULL AND sn.invalidated_at IS NULL
                    ) THEN 1 ELSE 0 END) AS repointable
           FROM nodes nd
           JOIN edges e ON e.dst = nd.id
           JOIN nodes ns ON ns.id = e.src
          WHERE nd.memory_kind IN (@semantic, @episodic) AND nd.invalidated_at IS NOT NULL
            AND e.invalidated_at IS NULL AND e.type <> @supersedes
            AND ns.memory_kind IN (@semantic, @episodic) AND ns.invalidated_at IS NULL`,
      )
      .get({
        semantic: authored[0],
        episodic: authored[1],
        supersedes: EdgeType.SUPERSEDES,
      }) as { all_edges: number; repointable: number | null };

    // Live authored nodes unreachable from the densest hub — i.e. everything a graph
    // view would render floating. Walks the undirected live subgraph, which is the
    // authored side only (~200 nodes), never the mirror mass.
    const detached = this.db
      .prepare(
        `WITH RECURSIVE
         live AS (SELECT id FROM nodes
                   WHERE memory_kind IN (@semantic, @episodic) AND invalidated_at IS NULL),
         le AS (SELECT e.src a, e.dst b FROM edges e
                  JOIN live s ON s.id = e.src JOIN live d ON d.id = e.dst
                 WHERE e.invalidated_at IS NULL
                UNION
                SELECT e.dst, e.src FROM edges e
                  JOIN live s ON s.id = e.src JOIN live d ON d.id = e.dst
                 WHERE e.invalidated_at IS NULL),
         seed AS (SELECT a AS id FROM le GROUP BY a ORDER BY COUNT(*) DESC LIMIT 1),
         reach(id) AS (SELECT id FROM seed
                       UNION SELECT le.b FROM le JOIN reach ON le.a = reach.id)
         SELECT COUNT(*) AS c FROM live
          WHERE EXISTS (SELECT 1 FROM le) AND id NOT IN (SELECT id FROM reach)`,
      )
      .get({ semantic: authored[0], episodic: authored[1] }) as { c: number };

    return {
      dangling_edges: dangling.all_edges,
      repointable_edges: dangling.repointable ?? 0,
      detached_nodes: detached.c,
    };
  }
}
