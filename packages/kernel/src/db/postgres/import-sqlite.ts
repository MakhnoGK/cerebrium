import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import type { PgDatabase } from "@/db/postgres/database";
import { ACTIVE_SPACE, toVectorLiteral } from "@/db/postgres/internal";

// Copies authored memory from a SQLite store into a Postgres one. Idempotent by id: rows
// that exist are updated where they are mutable and left alone where they are append-only,
// so a re-run converges instead of duplicating. The code mirror is not copied; authored
// edges into it are kept as `code_refs` for the code index to re-link later.

export interface ImportReport {
  tables: Record<string, number>;
  dropped: { edges_to_external_mirrors: number; edges_not_authored: number };
}

export interface VerifyReport {
  ok: boolean;
  tables: Record<string, { source: number; target: number; hash_match: boolean | null }>;
}

const AUTHORED = `n.memory_kind IN ('${MemoryKind.SEMANTIC}', '${MemoryKind.EPISODIC}')`;

// The authored subset of the source, as the queries both import and verify read it.
const SOURCE: Record<string, string> = {
  nodes: `SELECT n.* FROM nodes n WHERE ${AUTHORED} ORDER BY n.id`,
  revisions: `SELECT r.* FROM revisions r JOIN nodes n ON n.id = r.node_id WHERE ${AUTHORED}
              ORDER BY r.node_id, r.rev`,
  node_text: `SELECT f.node_id, f.title, f.content AS body FROM node_fts f
              JOIN nodes n ON n.id = f.node_id WHERE ${AUTHORED} ORDER BY f.node_id`,
  chunks: `SELECT c.id, c.node_id, c.rev, c.heading_path, c.seq, c.text, c.stale FROM chunks c
           JOIN nodes n ON n.id = c.node_id WHERE ${AUTHORED} ORDER BY c.id`,
  edges: `SELECT e.* FROM edges e
          JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
          WHERE s.memory_kind IN ('semantic','episodic') AND d.memory_kind IN ('semantic','episodic')
          ORDER BY e.src, e.dst, e.type`,
  sessions: "SELECT * FROM sessions ORDER BY id",
  principals: "SELECT * FROM principals ORDER BY id",
  events: "SELECT * FROM events ORDER BY id",
  revision_annotations: `SELECT a.* FROM revision_annotations a JOIN nodes n ON n.id = a.node_id
                         WHERE ${AUTHORED} ORDER BY a.node_id, a.rev`,
  consolidation_runs: "SELECT * FROM consolidation_runs ORDER BY id",
  review_decisions: "SELECT * FROM review_decisions ORDER BY artifact_kind, artifact_ref",
};

const HASHED = ["nodes", "revisions", "node_text", "chunks", "edges", "sessions", "events"];

type Row = Record<string, unknown>;

function authoredIds(source: Database.Database): Set<string> {
  return new Set(
    (source.prepare(`SELECT n.id FROM nodes n WHERE ${AUTHORED}`).all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
}

function candidates(source: Database.Database, authored: Set<string>): Row[] {
  return (
    source.prepare("SELECT * FROM consolidation_candidates ORDER BY id").all() as Row[]
  ).filter((row) =>
    (JSON.parse(row.member_ids as string) as string[]).every((id) => authored.has(id)),
  );
}

function codeRefs(source: Database.Database): { refs: Row[]; external: number; other: number } {
  const rows = source
    .prepare(
      `SELECT e.src, e.type, e.valid_from, e.invalidated_at, d.origin AS dst_origin,
              sy.repo, sy.path, sy.qualified, sy.symbol_kind, d.invalidated_at AS dst_invalidated
       FROM edges e
       JOIN nodes s ON s.id = e.src
       JOIN nodes d ON d.id = e.dst
       LEFT JOIN symbols sy ON sy.node_id = d.id
       WHERE s.memory_kind IN ('semantic','episodic') AND d.memory_kind = 'mirror'
       ORDER BY e.src, e.dst, e.type`,
    )
    .all() as Row[];
  const refs: Row[] = [];
  let external = 0;
  let other = 0;

  for (const row of rows) {
    if (row.repo == null) {
      if (row.dst_origin !== "repo") external++;
      else other++;
      continue;
    }

    refs.push({
      src: row.src,
      type: row.type,
      repo: row.repo,
      path: row.path,
      qualified: row.qualified,
      symbol_kind: row.symbol_kind,
      symbol_live: row.dst_invalidated == null ? 1 : 0,
      valid_from: row.valid_from,
      invalidated_at: row.invalidated_at,
    });
  }

  return { refs, external, other };
}

function vectors(
  source: Database.Database,
): { chunk_id: string; embedding: string; model_version: string; ts: string }[] {
  const rows = source
    .prepare(
      `SELECT v.chunk_id AS chunk_id, v.embedding AS embedding,
              COALESCE(m.model_version, '1') AS model_version, COALESCE(m.ts, '') AS ts
       FROM chunk_vec v
       JOIN chunks c ON c.id = v.chunk_id
       JOIN nodes n ON n.id = c.node_id
       LEFT JOIN embedding_meta m ON m.chunk_id = v.chunk_id
       WHERE ${AUTHORED}
       ORDER BY v.chunk_id`,
    )
    .all() as { chunk_id: string; embedding: Buffer; model_version: string; ts: string }[];

  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    embedding: toVectorLiteral(
      Array.from(
        new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length / 4),
      ),
    ),
    model_version: r.model_version,
    ts: r.ts,
  }));
}

async function upsert(
  target: PgDatabase,
  table: string,
  rows: Row[],
  key: string[],
  mode: "update" | "ignore",
): Promise<number> {
  if (!rows.length) return 0;

  const columns = Object.keys(rows[0]!);
  const conflict =
    mode === "ignore"
      ? "DO NOTHING"
      : `DO UPDATE SET ${columns
          .filter((c) => !key.includes(c))
          .map((c) => `${c} = excluded.${c}`)
          .join(", ")}`;
  const sql = `INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${columns.map((c) => `@${c}`).join(", ")})
    ON CONFLICT (${key.join(", ")}) ${conflict}`;

  for (const row of rows) {
    await target.query(sql, row);
  }

  return rows.length;
}

export async function importSqlite(
  source: Database.Database,
  target: PgDatabase,
): Promise<ImportReport> {
  const authored = authoredIds(source);
  const all = (sql: string) => source.prepare(sql).all() as Row[];
  const tables: Record<string, number> = {};
  const { refs, external, other } = codeRefs(source);
  const nonAuthoredEdges = (
    source
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE NOT (s.memory_kind IN ('semantic','episodic') AND d.memory_kind IN ('semantic','episodic'))
           AND NOT (s.memory_kind IN ('semantic','episodic') AND d.memory_kind = 'mirror')`,
      )
      .get() as { c: number }
  ).c;

  await target.tx(async () => {
    tables.nodes = await upsert(target, "nodes", all(SOURCE.nodes!), ["id"], "update");
    tables.revisions = await upsert(
      target,
      "revisions",
      all(SOURCE.revisions!),
      ["node_id", "rev"],
      "ignore",
    );
    tables.node_text = await upsert(
      target,
      "node_text",
      all(SOURCE.node_text!),
      ["node_id"],
      "update",
    );
    tables.chunks = await upsert(target, "chunks", all(SOURCE.chunks!), ["id"], "update");
    tables.edges = await upsert(
      target,
      "edges",
      all(SOURCE.edges!),
      ["src", "dst", "type"],
      "update",
    );
    tables.sessions = await upsert(target, "sessions", all(SOURCE.sessions!), ["id"], "update");
    tables.principals = await upsert(
      target,
      "principals",
      all(SOURCE.principals!),
      ["id"],
      "update",
    );
    tables.events = await upsert(target, "events", all(SOURCE.events!), ["id"], "ignore");
    tables.revision_annotations = await upsert(
      target,
      "revision_annotations",
      all(SOURCE.revision_annotations!),
      ["node_id", "rev"],
      "ignore",
    );
    tables.consolidation_candidates = await upsert(
      target,
      "consolidation_candidates",
      candidates(source, authored),
      ["id"],
      "update",
    );
    tables.consolidation_runs = await upsert(
      target,
      "consolidation_runs",
      all(SOURCE.consolidation_runs!),
      ["id"],
      "update",
    );
    tables.review_decisions = await upsert(
      target,
      "review_decisions",
      all(SOURCE.review_decisions!),
      ["artifact_kind", "artifact_ref"],
      "update",
    );
    tables.code_refs = await upsert(
      target,
      "code_refs",
      refs,
      ["src", "type", "repo", "qualified"],
      "update",
    );

    const vecs = vectors(source);

    for (const v of vecs) {
      await target.query(
        `INSERT INTO chunk_vectors (space_id, chunk_id, embedding, model_version, ts)
         VALUES (${ACTIVE_SPACE}, @chunk_id, @embedding::vector, @model_version, @ts)
         ON CONFLICT (space_id, chunk_id) DO UPDATE SET
           embedding = excluded.embedding, model_version = excluded.model_version, ts = excluded.ts`,
        v,
      );
    }

    tables.chunk_vectors = vecs.length;
  });

  return {
    tables,
    dropped: { edges_to_external_mirrors: external, edges_not_authored: other + nonAuthoredEdges },
  };
}

function hashRows(rows: Row[], columns: string[]): string {
  const hash = createHash("sha256");

  for (const row of rows) {
    hash.update(JSON.stringify(columns.map((c) => row[c] ?? null)));
    hash.update("\n");
  }

  return hash.digest("hex");
}

// Per-table counts, and for the content tables a hash over every column in the same order
// on both sides.
export async function verifyImport(
  source: Database.Database,
  target: PgDatabase,
): Promise<VerifyReport> {
  const tables: VerifyReport["tables"] = {};
  const targetSql: Record<string, string> = {
    nodes: "SELECT * FROM nodes ORDER BY id",
    revisions: "SELECT * FROM revisions ORDER BY node_id, rev",
    node_text: "SELECT node_id, title, body FROM node_text ORDER BY node_id",
    chunks: "SELECT id, node_id, rev, heading_path, seq, text, stale FROM chunks ORDER BY id",
    edges: "SELECT * FROM edges ORDER BY src, dst, type",
    sessions: "SELECT * FROM sessions ORDER BY id",
    principals: "SELECT * FROM principals ORDER BY id",
    events: "SELECT * FROM events ORDER BY id",
    revision_annotations: "SELECT * FROM revision_annotations ORDER BY node_id, rev",
    consolidation_runs: "SELECT * FROM consolidation_runs ORDER BY id",
    review_decisions: "SELECT * FROM review_decisions ORDER BY artifact_kind, artifact_ref",
  };

  for (const [table, sql] of Object.entries(SOURCE)) {
    const from = source.prepare(sql).all() as Row[];
    const to = (await target.query(targetSql[table]!)).rows as Row[];
    const columns = from.length ? Object.keys(from[0]!) : [];

    tables[table] = {
      source: from.length,
      target: to.length,
      hash_match: HASHED.includes(table) ? hashRows(from, columns) === hashRows(to, columns) : null,
    };
  }

  const vectorCount = (
    source
      .prepare(
        `SELECT COUNT(*) AS c FROM chunk_vec v JOIN chunks c ON c.id = v.chunk_id
         JOIN nodes n ON n.id = c.node_id WHERE ${AUTHORED}`,
      )
      .get() as { c: number }
  ).c;
  const targetVectors = (
    await target.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM chunk_vectors WHERE space_id = ${ACTIVE_SPACE}`,
    )
  ).rows[0]!.c;

  tables.chunk_vectors = { source: vectorCount, target: targetVectors, hash_match: null };

  const ok = Object.values(tables).every((t) => t.source === t.target && t.hash_match !== false);

  return { ok, tables };
}
