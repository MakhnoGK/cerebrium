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

  return null;
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
