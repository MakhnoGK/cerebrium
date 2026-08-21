import type { CallName } from "@/application/use-cases/contracts";

// The retrieval-outcome log: what a call surfaced, in the shape `report:readloop` joins on.
//
// This used to be produced by each MCP tool's `describeEvent`, which stopped being reached
// the moment the host became a proxy — the tool still ran, but the audit row was written on
// the other side of the socket by the pipeline, which knew only the node id. Reads lost
// their rows entirely, because a read's arguments carried no session to attribute them to.
//
// It lives here rather than in a delivery layer because the pipeline is what writes the
// row, and every input it needs is already in the call it just ran.
export function auditDetail(
  name: CallName,
  args: unknown,
  result: unknown,
): Record<string, unknown> | null {
  if (name === "search_memory") {
    const audit = (result as { audit?: unknown }).audit;

    return isRecord(audit) ? audit : null;
  }

  if (name === "fetch_nodes") {
    return fetchedDetail(args, result);
  }

  if (name === "lookup_code") {
    return lookedUpDetail(args, result);
  }

  if (name === "start_session") {
    return startedDetail(result);
  }

  if (name === "index_code") {
    return indexedDetail(result);
  }

  return null;
}

// The one call whose row points at no node, so its detail is the only record of what it
// changed.
function indexedDetail(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result) || !Array.isArray(result.results)) return null;

  return {
    repos: result.results.filter(isRecord).map((stats) => ({
      repo: stats.repo,
      indexed: stats.files_indexed,
      added: stats.symbols_added,
      updated: stats.symbols_updated,
      invalidated: stats.symbols_invalidated,
      branch: stats.branch,
      commit: stats.commit,
    })),
  };
}

// A code lookup surfaces symbols the same way a search surfaces nodes, and its ids join
// against a later fetch in exactly the same way.
function lookedUpDetail(args: unknown, result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;

  const symbols = Array.isArray(result.symbols) ? result.symbols : [];
  const detail: Record<string, unknown> = {
    results: symbols.length,
    ids: symbols.map(nodeIdOf).filter(isId),
  };

  if (!isRecord(args)) return detail;

  for (const key of ["name", "file", "repo"] as const) {
    if (typeof args[key] === "string") detail[key] = args[key];
  }

  return detail;
}

// The working set is a surfacing too: its ids join against a later `get` like a search
// row's do, which is what makes "did the agent use what it was handed" answerable.
function startedDetail(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;

  const workingSet = isRecord(result.working_set) ? result.working_set : {};

  return {
    project: result.project ?? null,
    ids: SURFACED_SECTIONS.flatMap((section) => {
      const entries = workingSet[section];

      return (Array.isArray(entries) ? entries : []).map(nodeIdOf).filter(isId);
    }),
  };
}

// An allowlist, not a scan: `stale_sources` also carries an `id`, but a source id is not
// a node id.
const SURFACED_SECTIONS = ["tasks", "checkpoints", "semantic", "recent"];

// A use case answers `{envelope:{id},facets,neighbors}` while a delivery layer flattens the
// envelope into the entry itself. Both shapes reach here.
function nodeIdOf(entry: unknown): unknown {
  if (!isRecord(entry)) return null;

  return isRecord(entry.envelope) ? entry.envelope.id : entry.id;
}

function isId(value: unknown): value is string {
  return typeof value === "string";
}

// The fetch half of the log: the requested ids join against the ids a preceding `search`
// returned, and `found` says how many still resolved. An outline is a decision aid rather
// than a read, and stays distinguishable so it is not counted as evidence the agent found
// the node worth its tokens.
function fetchedDetail(args: unknown, result: unknown): Record<string, unknown> | null {
  if (!isRecord(args) || !isRecord(result)) return null;

  const ids = Array.isArray(args.ids) ? args.ids : [];
  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  const notFound = Array.isArray(result.not_found) ? result.not_found : [];
  const sections = Array.isArray(args.sections) ? args.sections : [];

  const detail: Record<string, unknown> = { ids, found: nodes.length };

  if (notFound.length) detail.not_found = notFound;
  if (sections.length) detail.sections = sections;
  if (args.outline === true) detail.outline = true;

  return detail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
