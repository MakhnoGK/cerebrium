import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";
import type { SymbolLookup } from "@/core/types";

export interface FetchNodesArgs {
  ids: string[];
  rev?: number;
  as_of?: string;
  sections?: string[];
  outline?: boolean;
  include_revisions?: boolean;
}

// `nodes` stays `unknown[]`: its shape varies by node kind (symbol source, mirror facets,
// a pinned revision), and only its length is needed at the audit boundary.
export interface FetchNodesResult {
  nodes: unknown[];
  not_found: string[];
  // The ids that resolved, for a caller that has to record the use itself because this
  // ran somewhere that cannot write.
  used: string[];
}

export type FetchNodes = UseCase<FetchNodesArgs, FetchNodesResult>;

export const FETCH_NODES = useCaseToken<FetchNodesArgs, FetchNodesResult>("FetchNodes");

export interface LookupCodeArgs {
  name?: string;
  file?: string;
  repo?: string;
  limit: number;
}

export interface LookupCodeResult {
  symbols: SymbolLookup[];
}

export type LookupCode = UseCase<LookupCodeArgs, LookupCodeResult>;

export const LOOKUP_CODE = useCaseToken<LookupCodeArgs, LookupCodeResult>("LookupCode");
