import { inject, injectable } from "tsyringe";
import type { TechStats } from "@cerebrium/contracts/types";
import { EdgeType, JobKind, MemoryKind } from "@cerebrium/contracts/vocab";
import {
  EMBEDDING_QUEUE_REPO_TOKEN,
  JOBS_REPO_TOKEN,
  type EmbeddingQueueRepo,
  type JobsRepo,
  type StatsRepo,
} from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import { PG_TOKEN, type PgDatabase } from "@/db/postgres/database";
import { ACTIVE_SPACE } from "@/db/postgres/internal";

@injectable()
export class PgStatsRepo extends PgBaseRepo implements StatsRepo {
  constructor(
    @inject(PG_TOKEN) db: PgDatabase,
    @inject(EMBEDDING_QUEUE_REPO_TOKEN) private readonly queue: EmbeddingQueueRepo,
    @inject(JOBS_REPO_TOKEN) private readonly jobs: JobsRepo,
  ) {
    super(db);
  }

  async stats(): Promise<{
    nodes_by_kind: Record<string, number>;
    last_activity: string | null;
    embedding: { backlog: number; parked: number };
  }> {
    return {
      nodes_by_kind: await this.nodesByKind(),
      last_activity:
        (await this.one<{ t: string | null }>("SELECT MAX(ts) AS t FROM events"))?.t ?? null,
      embedding: await this.queue.embeddingStats(),
    };
  }

  async dbPath(): Promise<string> {
    return this.db.identity;
  }

  async techStats(now: string): Promise<TechStats> {
    const count = async (sql: string) => (await this.one<{ c: number }>(sql))?.c ?? 0;

    const nodes_by_kind = await this.nodesByKind();
    const nodes_total = Object.values(nodes_by_kind).reduce((a, b) => a + b, 0);
    const { backlog, parked } = await this.queue.embeddingStats();
    const queueAgg = await this.one<{
      total: number;
      with_errors: number | null;
      oldest: string | null;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS with_errors,
              MIN(enqueued_at) AS oldest FROM embedding_queue`,
    );
    const attempts_histogram: Record<string, number> = {};

    for (const r of await this.all<{ attempts: number; c: number }>(
      "SELECT attempts, COUNT(*) AS c FROM embedding_queue GROUP BY attempts ORDER BY attempts",
    )) {
      attempts_histogram[String(r.attempts)] = r.c;
    }

    const vectors = await count(
      `SELECT COUNT(*) AS c FROM chunk_vectors WHERE space_id = ${ACTIVE_SPACE}`,
    );
    const storage = await this.one<{ bytes: number; block: number }>(
      `SELECT pg_database_size(current_database()) AS bytes,
              current_setting('block_size')::int AS block`,
    );
    const lease = await this.one<{ owner: string; expires_at: string }>(
      "SELECT owner, expires_at FROM worker_lease WHERE role = 'embedding'",
    );
    const sweepLease = await this.one<{ owner: string; expires_at: string }>(
      "SELECT owner, expires_at FROM worker_lease WHERE role = 'consolidation'",
    );
    const candStats = await this.one<{
      pending: number | null;
      applied: number | null;
      dismissed: number | null;
    }>(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed
       FROM consolidation_candidates`,
    );
    const lastRun = await this.one<{
      started_at: string;
      stage: string | null;
      last_error: string | null;
    }>(
      "SELECT started_at, stage, last_error FROM consolidation_runs ORDER BY started_at DESC LIMIT 1",
    );
    const bytes = storage?.bytes ?? 0;
    const block = storage?.block ?? 8192;

    return {
      queue: {
        backlog,
        parked,
        total: queueAgg?.total ?? 0,
        with_errors: queueAgg?.with_errors ?? 0,
        oldest_enqueued_at: queueAgg?.oldest ?? null,
        attempts_histogram,
      },
      content: {
        nodes_by_kind,
        nodes_total,
        edges: await count("SELECT COUNT(*) AS c FROM edges WHERE invalidated_at IS NULL"),
        chunks_active: await count("SELECT COUNT(*) AS c FROM chunks WHERE stale = 0"),
        chunks_stale: await count("SELECT COUNT(*) AS c FROM chunks WHERE stale = 1"),
        chunks_embedded: vectors,
        chunks_unembedded: await count(
          `SELECT COUNT(*) AS c FROM chunks c WHERE c.stale = 0 AND NOT EXISTS (
             SELECT 1 FROM chunk_vectors v WHERE v.space_id = ${ACTIVE_SPACE} AND v.chunk_id = c.id)`,
        ),
        vectors_authored: vectors,
        vectors_code: 0,
        sessions: await count("SELECT COUNT(*) AS c FROM sessions"),
        events: await count("SELECT COUNT(*) AS c FROM events"),
      },
      storage: {
        db_path: this.db.identity,
        db_bytes: bytes,
        wal_bytes: 0,
        page_count: Math.round(bytes / block),
        page_size: block,
      },
      drain: {
        lease_owner: lease?.owner ?? null,
        lease_expires_at: lease?.expires_at ?? null,
        lease_active: !!lease && lease.expires_at > now,
      },
      graph: await this.graphHealth(),
      consolidation: {
        pending: candStats?.pending ?? 0,
        applied: candStats?.applied ?? 0,
        dismissed: candStats?.dismissed ?? 0,
        runs_total: await count("SELECT COUNT(*) AS c FROM consolidation_runs"),
        last_run_at: lastRun?.started_at ?? null,
        last_error: lastRun?.last_error ?? null,
        last_stage: lastRun?.stage ?? null,
        sweep_running: !!sweepLease && sweepLease.expires_at > now,
        sweep_lease_owner: sweepLease?.owner ?? null,
        sweep_lease_expires_at: sweepLease?.expires_at ?? null,
      },
      jobs: await this.jobStats(),
      code_repos: [],
      last_activity:
        (await this.one<{ t: string | null }>("SELECT MAX(ts) AS t FROM events"))?.t ?? null,
    };
  }

  private async nodesByKind(): Promise<Record<string, number>> {
    const nodes_by_kind: Record<string, number> = { episodic: 0, semantic: 0, mirror: 0 };

    for (const r of await this.all<{ memory_kind: string; c: number }>(
      "SELECT memory_kind, COUNT(*) AS c FROM nodes GROUP BY memory_kind",
    )) {
      nodes_by_kind[r.memory_kind] = r.c;
    }

    return nodes_by_kind;
  }

  private async jobStats(): Promise<TechStats["jobs"]> {
    const [last] = await this.jobs.recent({ kind: JobKind.CODE_INDEX, limit: 1 });

    return {
      by_state: await this.jobs.counts(),
      last_code_index_at: last?.ended_at ?? null,
      last_code_index_error: last?.last_error ?? null,
      code_index_open: await this.jobs.hasOpen(JobKind.CODE_INDEX),
    };
  }

  private async graphHealth(): Promise<TechStats["graph"]> {
    const params = {
      semantic: MemoryKind.SEMANTIC,
      episodic: MemoryKind.EPISODIC,
      supersedes: EdgeType.SUPERSEDES,
    };

    const dangling = await this.one<{ all_edges: number; repointable: number | null }>(
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
      params,
    );

    const detached = await this.one<{ c: number }>(
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
       seed AS (SELECT a AS id FROM le GROUP BY a ORDER BY COUNT(*) DESC, a LIMIT 1),
       reach(id) AS (SELECT id FROM seed
                     UNION SELECT le.b FROM le JOIN reach ON le.a = reach.id)
       SELECT COUNT(*) AS c FROM live
        WHERE EXISTS (SELECT 1 FROM le) AND id NOT IN (SELECT id FROM reach)`,
      { semantic: params.semantic, episodic: params.episodic },
    );

    const links = await this.one<{ untyped: number; typed: number; edgeless: number }>(
      `WITH live AS (SELECT id FROM nodes
                   WHERE memory_kind IN (@semantic, @episodic) AND invalidated_at IS NULL),
       le AS (SELECT e.src, e.dst, e.type FROM edges e
                JOIN live s ON s.id = e.src JOIN live d ON d.id = e.dst
               WHERE e.invalidated_at IS NULL AND e.src <> e.dst)
       SELECT (SELECT COUNT(*) FROM le WHERE type = @similar) AS untyped,
              (SELECT COUNT(*) FROM le WHERE type <> @similar) AS typed,
              (SELECT COUNT(*) FROM live
                WHERE id NOT IN (SELECT src FROM le) AND id NOT IN (SELECT dst FROM le)) AS edgeless`,
      { semantic: params.semantic, episodic: params.episodic, similar: EdgeType.SIMILAR_TO },
    );

    return {
      dangling_edges: dangling?.all_edges ?? 0,
      repointable_edges: dangling?.repointable ?? 0,
      detached_nodes: detached?.c ?? 0,
      edgeless_nodes: links?.edgeless ?? 0,
      untyped_links: links?.untyped ?? 0,
      typed_links: links?.typed ?? 0,
    };
  }
}
