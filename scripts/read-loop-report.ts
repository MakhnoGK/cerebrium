#!/usr/bin/env node
import "reflect-metadata";
import type Database from "better-sqlite3";
import { DB_TOKEN } from "@/db/repositories/base";
import { buildContainer } from "@/container";
import { DatabaseConfig } from "@/infrastructure/config";

// Read-loop report: `npm run report:readloop`. Answers "is a node that is never fetched
// waste, or is it doing its job as a search envelope" — the question the store could not
// ask about itself, because only the fetch half of retrieval was logged. Read-only: opens
// the DB via the `cli` role, so it never migrates and never becomes a second writer.
//
// The join is `events`: a surfacing row lists the node ids put in front of the agent, a
// later `get` in the same session lists the ids it actually spent tokens on. Everything
// below is that join, cut three ways — by rank, by retrieval path, and per node.
//
// Flags: --json, --since <ISO instant>, --help.

const SURFACING_ACTIONS = ["search", "session_start", "code_lookup"] as const;
const AUTHORED_KINDS = ["semantic", "episodic"] as const;
const TOP_N = 10;
const RANK_MIN_SHOWN = 5;
const UNNAMED_WRITER = "(unnamed)";

type SurfacingAction = (typeof SURFACING_ACTIONS)[number];

interface EventRow {
  action: string;
  session_id: string;
  detail: string | null;
  ts: string;
}

export interface Surfacing {
  action: SurfacingAction;
  session: string;
  ts: string;
  ids: string[];
  matched: string[];
}

export interface Fetch {
  session: string;
  ts: string;
  ids: string[];
}

interface Coverage {
  action: string;
  rows: number;
  instrumented: number;
  first: string | null;
}

interface RankRow {
  rank: number;
  shown: number;
  fetched: number;
}

interface PathRow {
  matched: string;
  shown: number;
  fetched: number;
}

export interface Split {
  label: string;
  total: number;
  neverSurfaced: number;
  surfacedNotFetched: number;
  fetched: number;
}

export interface WriterRow {
  writer: string;
  sessions: number;
  searches: number;
  ownResultFetched: number;
  writes: number;
}

interface NodeCount {
  id: string;
  title: string;
  surfaced: number;
  fetched: number;
}

function main(): void {
  if (process.argv.includes("--help")) {
    process.stdout.write("usage: npm run report:readloop -- [--json] [--since <ISO instant>]\n");
    return;
  }

  const container = buildContainer({ role: "cli" });
  const db = container.resolve<Database.Database>(DB_TOKEN);
  const dbPath = container.resolve(DatabaseConfig).path;

  const sinceFlag = process.argv[process.argv.indexOf("--since") + 1];
  const since =
    process.argv.includes("--since") && sinceFlag ? sinceFlag : (firstInstrumented(db) ?? "");

  report(db, dbPath, since, process.argv.includes("--json"));
}

// Surfaced ids only started being logged partway through this store's life, and each action
// started on its own date. Anything before the first instrumented search reads as a zero
// that means "not recorded", not "not surfaced" — so that is where the window opens.
function firstInstrumented(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT MIN(ts) AS ts FROM events WHERE action = 'search' AND detail LIKE '%"ids"%'`)
    .get() as { ts: string | null };

  return row.ts;
}

function report(db: Database.Database, dbPath: string, since: string, asJson: boolean): void {
  const { surfacings, fetches } = load(db, since);
  const coverage = instrumentationCoverage(db, since);

  const searches = surfacings.filter((s) => s.action === "search");
  const fetchedAfter = fetchIndex(fetches);

  const followThrough = followThroughOf(searches, fetchedAfter);
  const ranks = rankCurve(searches, fetchedAfter);
  const paths = pathCurve(searches, fetchedAfter);

  const surfacedCount = tally(surfacings);
  const fetchedCount = tally(fetches.filter((f) => !f.outline));
  const splits = AUTHORED_KINDS.map((kind) =>
    splitOf(`live ${kind}`, liveNodes(db, kind), surfacedCount, fetchedCount),
  );
  splits.unshift(
    splitOf("live authored (semantic+episodic)", liveNodes(db), surfacedCount, fetchedCount),
  );

  const titles = titleIndex(db);
  const mostSurfaced = topBy(surfacedCount, fetchedCount, titles, () => true);
  const ignored = topBy(surfacedCount, fetchedCount, titles, (id) => !fetchedCount.get(id));
  const writers = writerCurve(searches, fetchedAfter, writerIndex(db), writeCounts(db, since));

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          db_path: dbPath,
          window_from: since,
          instrumentation: coverage,
          follow_through: followThrough,
          rank_curve: ranks,
          path_curve: paths,
          node_splits: splits,
          writers,
          most_surfaced: mostSurfaced,
          most_surfaced_never_fetched: ignored,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const L: string[] = [];

  L.push(`cerebrium read-loop report   ${dbPath}`);
  L.push(`window from ${since || "(nothing instrumented yet)"}`);
  L.push("");

  L.push("── Instrumentation coverage: how much of each action's history carries ids ──");
  L.push("  action           rows   with ids   first instrumented row");
  for (const c of coverage) {
    L.push(
      `  ${c.action.padEnd(14)} ${String(c.rows).padStart(5)}   ${String(c.instrumented).padStart(8)}   ${c.first ?? "—"}`,
    );
  }
  L.push("  An action with no instrumented rows contributes nothing below; it is not");
  L.push("  evidence that its results go unused.");
  L.push("");

  L.push("── Did the search lead anywhere? (same session, any later get) ──");
  L.push(`  searches in window                      ${followThrough.searches}`);
  L.push(
    `  followed by any get                     ${followThrough.anyGet}   ${pct(followThrough.anyGet, followThrough.searches)}`,
  );
  L.push(
    `  own result fetched                      ${followThrough.ownResultFetched}   ${pct(followThrough.ownResultFetched, followThrough.searches)}`,
  );
  L.push(
    `  answered from the envelope alone        ${followThrough.envelopeOnly}   ${pct(followThrough.envelopeOnly, followThrough.searches)}`,
  );
  L.push("  The last line is the documented normal path, not a miss: an envelope plus");
  L.push("  best_chunk is often the whole answer. It is the share that must be subtracted");
  L.push("  from any 'never fetched' figure before calling it waste.");
  L.push("");

  L.push("── Was the ranking right? Fetch rate by rank ──");
  L.push("  rank   shown   fetched   rate");
  for (const r of ranks) {
    L.push(
      `  ${String(r.rank).padStart(4)}   ${String(r.shown).padStart(5)}   ${String(r.fetched).padStart(7)}   ${pct(r.fetched, r.shown)}`,
    );
  }
  L.push(`  Ranks shown fewer than ${RANK_MIN_SHOWN} times are omitted.`);
  L.push("");

  if (paths.length) {
    L.push("── Which retrieval path produces results worth fetching? ──");
    L.push("  path     shown   fetched   rate");
    for (const p of paths) {
      L.push(
        `  ${p.matched.padEnd(7)} ${String(p.shown).padStart(6)}   ${String(p.fetched).padStart(7)}   ${pct(p.fetched, p.shown)}`,
      );
    }
    L.push("");
  }

  L.push("── Per node: splitting 'never fetched' into its three causes ──");
  for (const s of splits) {
    L.push(`  ${s.label} (n=${s.total})`);
    L.push(
      `    never surfaced        ${String(s.neverSurfaced).padStart(5)}   ${pct(s.neverSurfaced, s.total)}   unreachable by the queries actually asked`,
    );
    L.push(
      `    surfaced, not fetched ${String(s.surfacedNotFetched).padStart(5)}   ${pct(s.surfacedNotFetched, s.total)}   envelope-answered or irrelevant`,
    );
    L.push(
      `    fetched               ${String(s.fetched).padStart(5)}   ${pct(s.fetched, s.total)}   read in full at least once`,
    );
  }
  L.push("  Mirror nodes are excluded: the code index dwarfs the authored store and would");
  L.push("  turn every share into a statement about how much code is indexed.");
  L.push("");

  L.push("── By writer ──");
  L.push("  writer                   sessions   searches   own result fetched   writes");
  for (const w of writers) {
    L.push(
      `  ${w.writer.padEnd(22)} ${String(w.sessions).padStart(8)}   ${String(w.searches).padStart(8)}   ` +
        `${pct(w.ownResultFetched, w.searches).padStart(18)}   ${String(w.writes).padStart(6)}`,
    );
  }
  L.push("  `sessions.client` comes from the MCP initialize handshake and only exists from");
  L.push("  2026-08-09 on; every session older than that reads as (unnamed).");
  L.push("");

  L.push("── Most surfaced ──");
  for (const n of mostSurfaced) {
    L.push(
      `  ${String(n.surfaced).padStart(4)}x surfaced  ${String(n.fetched).padStart(4)}x fetched  ${n.title}`,
    );
  }
  L.push("");

  L.push("── Surfaced most, never fetched (the ranking's own noise) ──");
  for (const n of ignored) {
    L.push(`  ${String(n.surfaced).padStart(4)}x surfaced     0x fetched  ${n.title}`);
  }

  process.stdout.write(L.join("\n") + "\n");
}

// ---- loading ----------------------------------------------------------------

function load(
  db: Database.Database,
  since: string,
): { surfacings: Surfacing[]; fetches: (Fetch & { outline: boolean })[] } {
  const rows = db
    .prepare(
      `SELECT action, session_id, detail, ts FROM events
       WHERE ts >= ? AND action IN ('search','get','session_start','code_lookup')
       ORDER BY ts`,
    )
    .all(since) as EventRow[];

  const surfacings: Surfacing[] = [];
  const fetches: (Fetch & { outline: boolean })[] = [];

  for (const row of rows) {
    const detail = parse(row.detail);
    const ids = stringArray(detail.ids);

    if (!ids.length) {
      continue;
    }

    if (row.action === "get") {
      fetches.push({
        session: row.session_id,
        ts: row.ts,
        ids,
        outline: detail.outline === true,
      });
      continue;
    }

    surfacings.push({
      action: row.action as SurfacingAction,
      session: row.session_id,
      ts: row.ts,
      ids,
      matched: stringArray(detail.matched),
    });
  }

  return { surfacings, fetches };
}

function instrumentationCoverage(db: Database.Database, since: string): Coverage[] {
  return [...SURFACING_ACTIONS, "get"].map((action) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS rows,
                SUM(CASE WHEN detail LIKE '%"ids"%' THEN 1 ELSE 0 END) AS instrumented,
                MIN(CASE WHEN detail LIKE '%"ids"%' THEN ts END) AS first
         FROM events WHERE action = ? AND ts >= ?`,
      )
      .get(action, since) as { rows: number; instrumented: number | null; first: string | null };

    return { action, rows: row.rows, instrumented: row.instrumented ?? 0, first: row.first };
  });
}

function liveNodes(db: Database.Database, kind?: string): string[] {
  const sql = kind
    ? `SELECT id FROM nodes WHERE invalidated_at IS NULL AND memory_kind = ?`
    : `SELECT id FROM nodes WHERE invalidated_at IS NULL AND memory_kind IN ('semantic','episodic')`;

  const rows = (kind ? db.prepare(sql).all(kind) : db.prepare(sql).all()) as { id: string }[];

  return rows.map((r) => r.id);
}

// This report opens the store read-only and so cannot migrate it. A store whose server
// has not restarted since migration 020 still has no `client`, and a crash there would
// take the whole report with it — every writer simply reads as unnamed instead.
function hasWriterColumn(db: Database.Database): boolean {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];

  return columns.some((c) => c.name === "client");
}

function writerIndex(db: Database.Database): Map<string, string> {
  if (!hasWriterColumn(db)) {
    return new Map();
  }

  const rows = db.prepare(`SELECT id, client FROM sessions`).all() as {
    id: string;
    client: string | null;
  }[];

  return new Map(rows.map((r) => [r.id, r.client ?? UNNAMED_WRITER]));
}

function writeCounts(db: Database.Database, since: string): Map<string, number> {
  const writer = hasWriterColumn(db) ? "COALESCE(s.client, ?)" : "?";
  const rows = db
    .prepare(
      `SELECT ${writer} AS writer, COUNT(*) AS writes
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.ts >= ? AND e.action IN ('write','update','invalidate','checkpoint','link')
       GROUP BY writer`,
    )
    .all(UNNAMED_WRITER, since) as { writer: string; writes: number }[];

  return new Map(rows.map((r) => [r.writer, r.writes]));
}

function titleIndex(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`SELECT id, title FROM nodes`).all() as { id: string; title: string }[];

  return new Map(rows.map((r) => [r.id, r.title]));
}

// ---- metrics ----------------------------------------------------------------

// Fetches grouped by session and kept in time order, so "was this surfacing acted on" is a
// scan forward from its own timestamp rather than a whole-session set membership test.
export function fetchIndex(fetches: (Fetch & { outline: boolean })[]): Map<string, Fetch[]> {
  const out = new Map<string, Fetch[]>();

  for (const fetch of fetches) {
    if (fetch.outline) {
      continue;
    }

    const list = out.get(fetch.session) ?? [];
    list.push(fetch);
    out.set(fetch.session, list);
  }

  return out;
}

function fetchedAfterOf(surfacing: Surfacing, index: Map<string, Fetch[]>): Set<string> {
  const out = new Set<string>();

  for (const fetch of index.get(surfacing.session) ?? []) {
    if (fetch.ts > surfacing.ts) {
      for (const id of fetch.ids) out.add(id);
    }
  }

  return out;
}

export function followThroughOf(
  searches: Surfacing[],
  index: Map<string, Fetch[]>,
): { searches: number; anyGet: number; ownResultFetched: number; envelopeOnly: number } {
  let anyGet = 0;
  let ownResultFetched = 0;

  for (const search of searches) {
    const later = fetchedAfterOf(search, index);

    if (later.size) anyGet++;
    if (search.ids.some((id) => later.has(id))) ownResultFetched++;
  }

  return {
    searches: searches.length,
    anyGet,
    ownResultFetched,
    envelopeOnly: searches.length - ownResultFetched,
  };
}

export function rankCurve(searches: Surfacing[], index: Map<string, Fetch[]>): RankRow[] {
  const shown = new Map<number, number>();
  const fetched = new Map<number, number>();

  for (const search of searches) {
    const later = fetchedAfterOf(search, index);

    search.ids.forEach((id, rank) => {
      shown.set(rank, (shown.get(rank) ?? 0) + 1);
      if (later.has(id)) fetched.set(rank, (fetched.get(rank) ?? 0) + 1);
    });
  }

  return [...shown.entries()]
    .filter(([, count]) => count >= RANK_MIN_SHOWN)
    .sort(([a], [b]) => a - b)
    .map(([rank, count]) => ({ rank, shown: count, fetched: fetched.get(rank) ?? 0 }));
}

export function pathCurve(searches: Surfacing[], index: Map<string, Fetch[]>): PathRow[] {
  const shown = new Map<string, number>();
  const fetched = new Map<string, number>();

  for (const search of searches) {
    const later = fetchedAfterOf(search, index);

    search.ids.forEach((id, rank) => {
      const path = search.matched[rank];

      if (path === undefined) {
        return;
      }

      shown.set(path, (shown.get(path) ?? 0) + 1);
      if (later.has(id)) fetched.set(path, (fetched.get(path) ?? 0) + 1);
    });
  }

  return [...shown.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([matched, count]) => ({ matched, shown: count, fetched: fetched.get(matched) ?? 0 }));
}

export function writerCurve(
  searches: Surfacing[],
  index: Map<string, Fetch[]>,
  writerOf: Map<string, string>,
  writes: Map<string, number>,
): WriterRow[] {
  const rows = new Map<string, WriterRow & { seen: Set<string> }>();

  const rowFor = (writer: string) => {
    const existing = rows.get(writer);

    if (existing) {
      return existing;
    }

    const fresh = {
      writer,
      sessions: 0,
      searches: 0,
      ownResultFetched: 0,
      writes: writes.get(writer) ?? 0,
      seen: new Set<string>(),
    };
    rows.set(writer, fresh);

    return fresh;
  };

  for (const writer of writes.keys()) rowFor(writer);

  for (const search of searches) {
    const row = rowFor(writerOf.get(search.session) ?? UNNAMED_WRITER);

    row.seen.add(search.session);
    row.sessions = row.seen.size;
    row.searches++;

    const later = fetchedAfterOf(search, index);
    if (search.ids.some((id) => later.has(id))) row.ownResultFetched++;
  }

  return [...rows.values()]
    .sort((a, b) => b.searches - a.searches || b.writes - a.writes)
    .map(({ seen: _seen, ...row }) => row);
}

export function tally(events: { ids: string[] }[]): Map<string, number> {
  const out = new Map<string, number>();

  for (const event of events) {
    for (const id of event.ids) out.set(id, (out.get(id) ?? 0) + 1);
  }

  return out;
}

export function splitOf(
  label: string,
  ids: string[],
  surfaced: Map<string, number>,
  fetched: Map<string, number>,
): Split {
  let neverSurfaced = 0;
  let surfacedNotFetched = 0;
  let everFetched = 0;

  for (const id of ids) {
    if (fetched.get(id)) everFetched++;
    else if (surfaced.get(id)) surfacedNotFetched++;
    else neverSurfaced++;
  }

  return { label, total: ids.length, neverSurfaced, surfacedNotFetched, fetched: everFetched };
}

function topBy(
  surfaced: Map<string, number>,
  fetched: Map<string, number>,
  titles: Map<string, string>,
  keep: (id: string) => boolean,
): NodeCount[] {
  return [...surfaced.entries()]
    .filter(([id]) => keep(id))
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_N)
    .map(([id, count]) => ({
      id,
      title: (titles.get(id) ?? "(unknown node)").slice(0, 70),
      surfaced: count,
      fetched: fetched.get(id) ?? 0,
    }));
}

// ---- primitives -------------------------------------------------------------

function parse(detail: string | null): Record<string, unknown> {
  if (!detail) {
    return {};
  }

  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function pct(part: number, whole: number): string {
  return whole ? `${((100 * part) / whole).toFixed(1).padStart(5)}%` : "    —";
}

if (process.env.VITEST === undefined) main();
