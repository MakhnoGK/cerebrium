import { OPERATOR_SNAPSHOT, STATS_SNAPSHOT } from "@/application/use-cases/contracts/operations";
import { FETCH_NODES, LOOKUP_CODE } from "@/application/use-cases/contracts/read";
import { SEARCH_MEMORY } from "@/application/use-cases/contracts/search";

// Use-case tokens are symbols, and a symbol cannot cross a worker or socket boundary. This
// is the name every out-of-process caller uses instead, so the mapping lives in exactly one
// place rather than being re-derived at each edge.
//
// Read-only by construction: nothing here may write. A worker holding a read-only database
// handle is the second line of defence, and this list is the first.
export const READ_SURFACE = {
  search_memory: SEARCH_MEMORY,
  fetch_nodes: FETCH_NODES,
  lookup_code: LOOKUP_CODE,
  stats_snapshot: STATS_SNAPSHOT,
  operator_snapshot: OPERATOR_SNAPSHOT,
} as const;

export type ReadName = keyof typeof READ_SURFACE;

// `status` has to answer while data reads are saturating the pool, so it is dispatched
// apart from them rather than queueing behind a search.
export const CONTROL_READS: readonly ReadName[] = ["stats_snapshot", "operator_snapshot"];

export function isReadName(name: string): name is ReadName {
  return Object.hasOwn(READ_SURFACE, name);
}

export function isControlRead(name: ReadName): boolean {
  return CONTROL_READS.includes(name);
}
