import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MemoryKind } from "@cerebrium/contracts/vocab";
import type { PgDatabase } from "@/db/postgres/database";
import { ACTIVE_SPACE, toVectorLiteral } from "@/db/postgres/internal";

// Copies authored memory from a SQLite store into a Postgres one. Idempotent by id: rows
// that exist are updated where they are mutable and left alone where they are append-only,
// so a re-run converges instead of duplicating. The code mirror is not copied; authored
// edges into it are kept as `code_refs`, resolved per branch by the host's code index. A
// repo map names each old local repo's `remote_key`; a repo it does not name keeps none.

// Old local repo name -> remote_key (host/owner/repo).
export type RepoMap = Record<string, string>;

// Which projects reach the target: exact names and `prefix*` patterns, plus project-less
// nodes when `global`. Rows that touch a node outside it are left behind.
export interface ProjectScope {
  projects: string[];
  global: boolean;
}

export interface ImportOptions {
  repoMap?: RepoMap;
  scope?: ProjectScope;
}

export interface ImportReport {
  tables: Record<string, number>;
  dropped: {
    edges_to_external_mirrors: number;
    edges_not_authored: number;
    out_of_scope_nodes: number;
  };
}

export interface VerifyReport {
  ok: boolean;
  // `target` counts the source's rows found in the target; `target_only` the rows the
  // target holds that the source does not (its own daemon's session, for one).
  tables: Record<
    string,
    { source: number; target: number; target_only: number; hash_match: boolean | null }
  >;
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

const KEYS: Record<string, string[]> = {
  nodes: ["id"],
  revisions: ["node_id", "rev"],
  node_text: ["node_id"],
  chunks: ["id"],
  edges: ["src", "dst", "type"],
  sessions: ["id"],
  principals: ["id"],
  events: ["id"],
  revision_annotations: ["node_id", "rev"],
  consolidation_runs: ["id"],
  review_decisions: ["artifact_kind", "artifact_ref"],
};

function keyOf(row: Row, columns: string[]): string {
  return JSON.stringify(columns.map((c) => row[c]));
}

type Row = Record<string, unknown>;

export function inScope(scope: ProjectScope, project: string | null): boolean {
  if (project === null || project === "") return scope.global;

  return scope.projects.some((pattern) =>
    pattern.endsWith("*") ? project.startsWith(pattern.slice(0, -1)) : project === pattern,
  );
}

export function parseScope(raw: string, global: boolean): ProjectScope {
  const projects = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (!projects.length) throw new Error("--projects names no project");

  return { projects, global };
}

function authoredIds(source: Database.Database, scope?: ProjectScope): Set<string> {
  const rows = source.prepare(`SELECT n.id, n.project FROM nodes n WHERE ${AUTHORED}`).all() as {
    id: string;
    project: string | null;
  }[];

  return new Set(rows.filter((r) => !scope || inScope(scope, r.project)).map((r) => r.id));
}

// The authored node ids a scoped import carries; null when nothing is scoped out.
function scopedIds(source: Database.Database, scope?: ProjectScope): Set<string> | null {
  return scope ? authoredIds(source, scope) : null;
}

const NODE_COLUMN: Record<string, string> = {
  nodes: "id",
  revisions: "node_id",
  node_text: "node_id",
  chunks: "node_id",
  revision_annotations: "node_id",
};

function keepRow(table: string, row: Row, ids: Set<string>): boolean {
  const column = NODE_COLUMN[table];

  if (column) return ids.has(row[column] as string);

  switch (table) {
    case "edges":
      return ids.has(row.src as string) && ids.has(row.dst as string);
    case "events":
      return row.node_id == null || ids.has(row.node_id as string);
    case "review_decisions": {
      const ref = row.artifact_ref as string;
      const members = row.artifact_kind === "edge" ? ref.split("|").slice(0, 2) : [ref];

      return members.every((id) => ids.has(id));
    }
    default:
      return true;
  }
}

function sourceRows(source: Database.Database, table: string, ids: Set<string> | null): Row[] {
  const rows = source.prepare(SOURCE[table]!).all() as Row[];

  return ids ? rows.filter((row) => keepRow(table, row, ids)) : rows;
}

function candidates(source: Database.Database, authored: Set<string>): Row[] {
  return (
    source.prepare("SELECT * FROM consolidation_candidates ORDER BY id").all() as Row[]
  ).filter((row) =>
    (JSON.parse(row.member_ids as string) as string[]).every((id) => authored.has(id)),
  );
}

const CODE_REF_KEY = ["src", "type", "repo", "path", "qualified"];

function codeRefs(
  source: Database.Database,
  repoMap?: RepoMap,
  ids: Set<string> | null = null,
): { refs: Row[]; external: number; other: number } {
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
    if (ids && !ids.has(row.src as string)) continue;

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
      ...(repoMap === undefined ? {} : { remote_key: repoMap[row.repo as string] ?? null }),
    });
  }

  return { refs, external, other };
}

function vectors(
  source: Database.Database,
  ids: Set<string> | null,
): { chunk_id: string; embedding: string; model_version: string; ts: string }[] {
  const rows = source
    .prepare(
      `SELECT v.chunk_id AS chunk_id, c.node_id AS node_id, v.embedding AS embedding,
              COALESCE(m.model_version, '1') AS model_version, COALESCE(m.ts, '') AS ts
       FROM chunk_vec v
       JOIN chunks c ON c.id = v.chunk_id
       JOIN nodes n ON n.id = c.node_id
       LEFT JOIN embedding_meta m ON m.chunk_id = v.chunk_id
       WHERE ${AUTHORED}
       ORDER BY v.chunk_id`,
    )
    .all() as {
    chunk_id: string;
    node_id: string;
    embedding: Buffer;
    model_version: string;
    ts: string;
  }[];

  return rows
    .filter((r) => !ids || ids.has(r.node_id))
    .map((r) => ({
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
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const ids = scopedIds(source, opts.scope);
  const authored = ids ?? authoredIds(source);
  const rows = (table: string) => sourceRows(source, table, ids);
  const tables: Record<string, number> = {};
  const { refs, external, other } = codeRefs(source, opts.repoMap, ids);
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
    tables.nodes = await upsert(target, "nodes", rows("nodes"), ["id"], "update");
    tables.revisions = await upsert(
      target,
      "revisions",
      rows("revisions"),
      ["node_id", "rev"],
      "ignore",
    );
    tables.node_text = await upsert(target, "node_text", rows("node_text"), ["node_id"], "update");
    tables.chunks = await upsert(target, "chunks", rows("chunks"), ["id"], "update");
    tables.edges = await upsert(target, "edges", rows("edges"), ["src", "dst", "type"], "update");
    tables.sessions = await upsert(target, "sessions", rows("sessions"), ["id"], "update");
    tables.principals = await upsert(target, "principals", rows("principals"), ["id"], "update");
    tables.events = await upsert(target, "events", rows("events"), ["id"], "ignore");
    tables.revision_annotations = await upsert(
      target,
      "revision_annotations",
      rows("revision_annotations"),
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
      rows("consolidation_runs"),
      ["id"],
      "update",
    );
    tables.review_decisions = await upsert(
      target,
      "review_decisions",
      rows("review_decisions"),
      ["artifact_kind", "artifact_ref"],
      "update",
    );
    tables.code_refs = await upsert(target, "code_refs", refs, CODE_REF_KEY, "update");

    const vecs = vectors(source, ids);

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
    dropped: {
      edges_to_external_mirrors: external,
      edges_not_authored: other + nonAuthoredEdges,
      out_of_scope_nodes: ids ? authoredIds(source).size - ids.size : 0,
    },
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
  opts: ImportOptions = {},
): Promise<VerifyReport> {
  const tables: VerifyReport["tables"] = {};
  const ids = scopedIds(source, opts.scope);
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

  for (const table of Object.keys(SOURCE)) {
    const from = sourceRows(source, table, ids);
    const all = (await target.query(targetSql[table]!)).rows as Row[];
    const columns = from.length ? Object.keys(from[0]!) : [];
    const keys = new Set(from.map((r) => keyOf(r, KEYS[table]!)));
    const to = all.filter((r) => keys.has(keyOf(r, KEYS[table]!)));

    tables[table] = {
      source: from.length,
      target: to.length,
      target_only: all.length - to.length,
      hash_match: HASHED.includes(table) ? hashRows(from, columns) === hashRows(to, columns) : null,
    };
  }

  const refs = codeRefs(source, opts.repoMap, ids).refs;
  const refColumns = refs.length ? Object.keys(refs[0]!) : [];
  const refKeys = new Set(refs.map((r) => keyOf(r, CODE_REF_KEY)));
  const targetRefs = (
    await target.query(
      `SELECT src, type, repo, path, qualified, symbol_kind, symbol_live, valid_from,
              invalidated_at, remote_key
       FROM code_refs ORDER BY src, type, repo, path, qualified`,
    )
  ).rows as Row[];
  const sourceRefs = [...refs].sort((a, b) =>
    keyOf(a, CODE_REF_KEY) < keyOf(b, CODE_REF_KEY) ? -1 : 1,
  );
  const matchedRefs = targetRefs
    .filter((r) => refKeys.has(keyOf(r, CODE_REF_KEY)))
    .sort((a, b) => (keyOf(a, CODE_REF_KEY) < keyOf(b, CODE_REF_KEY) ? -1 : 1));

  tables.code_refs = {
    source: refs.length,
    target: matchedRefs.length,
    target_only: targetRefs.length - matchedRefs.length,
    hash_match: hashRows(sourceRefs, refColumns) === hashRows(matchedRefs, refColumns),
  };

  const vectorCount = (
    source
      .prepare(
        `SELECT c.node_id AS node_id FROM chunk_vec v JOIN chunks c ON c.id = v.chunk_id
         JOIN nodes n ON n.id = c.node_id WHERE ${AUTHORED}`,
      )
      .all() as { node_id: string }[]
  ).filter((r) => !ids || ids.has(r.node_id)).length;
  const targetVectors = (
    await target.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM chunk_vectors WHERE space_id = ${ACTIVE_SPACE}`,
    )
  ).rows[0]!.c;

  tables.chunk_vectors = {
    source: vectorCount,
    target: Math.min(vectorCount, targetVectors),
    target_only: Math.max(0, targetVectors - vectorCount),
    hash_match: null,
  };

  const ok = Object.values(tables).every((t) => t.source === t.target && t.hash_match !== false);

  return { ok, tables };
}

// Names the remote_key of every ref written under an old local repo name. Rows are updated
// in place, never removed; a repo the map does not name is left as it is.
export async function remapCodeRefs(
  target: PgDatabase,
  repoMap: RepoMap,
): Promise<Record<string, number>> {
  const updated: Record<string, number> = {};

  await target.tx(async () => {
    for (const [repo, remoteKey] of Object.entries(repoMap).sort()) {
      updated[repo] =
        (
          await target.query(
            `UPDATE code_refs SET remote_key = @remoteKey
             WHERE repo = @repo AND remote_key IS DISTINCT FROM @remoteKey`,
            { repo, remoteKey },
          )
        ).rowCount ?? 0;
    }
  });

  return updated;
}

export function parseRepoMap(raw: string): RepoMap {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("a repo map is a JSON object of old repo name -> remote_key");
  }

  const map: RepoMap = {};

  for (const [repo, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      typeof key !== "string" ||
      !/^[^\s/]+(\/[^\s/]+)+$/.test(key) ||
      key !== key.toLowerCase()
    ) {
      throw new Error(
        `repo map: '${repo}' -> ${JSON.stringify(key)} is not a normalized remote_key`,
      );
    }

    map[repo] = key;
  }

  return map;
}
