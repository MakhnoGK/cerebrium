import type { CodeContext } from "@cerebrium/contracts/code";
import type { SymbolLookup } from "@cerebrium/contracts/types";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

export interface FetchNodesArgs {
  // Carried only so the call can be attributed in the audit log. The daemon reads it off
  // the arguments, which is the only place a call's session travels.
  session_id?: string;
  ids: string[];
  rev?: number;
  as_of?: string;
  sections?: string[];
  outline?: boolean;
  include_revisions?: boolean;
  code_context?: CodeContext;
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
  session_id?: string;
  name?: string;
  file?: string;
  repo?: string;
  branch?: string;
  limit: number;
  code_context?: CodeContext;
}

export interface LookupCodeResult {
  symbols: SymbolLookup[];
  // Which branches were read, when the per-branch index answered.
  notes?: string[];
}

export type LookupCode = UseCase<LookupCodeArgs, LookupCodeResult>;

export const LOOKUP_CODE = useCaseToken<LookupCodeArgs, LookupCodeResult>("LookupCode");
