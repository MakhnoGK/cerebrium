import type { CodeCallRef, CodeImportRef, CodeRepoDescriptor } from "@cerebrium/contracts/code";
import type { ExtractedSymbol } from "@cerebrium/contracts/types";
import type { TextQuery } from "@/core/fts";

export const BRANCH_CODE_REPO_TOKEN = Symbol("BranchCodeRepo");

export interface CodeRepoRow {
  id: string;
  remote_key: string;
  display_name: string;
  default_branch: string | null;
}

export interface CodeBranchRow {
  branch: string;
  commit_sha: string | null;
  dirty: boolean;
  indexed_at: string;
  retired_at: string | null;
}

// What reads are scoped to: one branch of one repo, optionally as it stood at a past instant.
export interface BranchScope {
  repo: CodeRepoRow;
  branch: string;
  asOf?: string;
}

// What one parse of a file produced. External ids name symbols within the parse only.
export interface UnitParse {
  symbols: ExtractedSymbol[];
  defines: { src: string; dst: string }[];
  imports: CodeImportRef[];
  calls: CodeCallRef[];
}

export interface CodeUnitSource {
  id: string;
  path: string;
  lang: string;
  content: string;
}

export interface CodeSymbolRow {
  id: string;
  unit_id: string;
  kind: string;
  name: string;
  qualified: string;
  signature: string | null;
  summary: string;
  start_line: number;
  end_line: number;
  path: string;
  lang: string;
  parsed_at: string;
  repo_id: string;
  remote_key: string;
  display_name: string;
  branch: string;
}

export interface CodeSymbolDetail {
  id: string;
  unit_id: string;
  kind: string;
  name: string;
  qualified: string;
  signature: string | null;
  summary: string;
  start_line: number;
  end_line: number;
  path: string;
  lang: string;
  parsed_at: string;
  source: string;
}

export interface CodeRefRow {
  src: string;
  type: string;
  repo: string;
  remote_key: string | null;
  path: string;
  qualified: string;
  symbol_kind: string;
}

export interface ResolvedCodeRef {
  src: string;
  type: string;
  symbol: CodeSymbolRow;
}

export interface UnitRefs {
  imports: CodeImportRef[];
  calls: CodeCallRef[];
}

export interface BranchFileChange {
  changed: number;
  removed: number;
}

export interface BranchCodeRepo {
  upsertRepo(desc: CodeRepoDescriptor & { display_name: string }, ts: string): Promise<CodeRepoRow>;
  repoByKey(remoteKey: string): Promise<CodeRepoRow | undefined>;
  // Matched on remote_key or display name.
  reposNamed(name: string): Promise<CodeRepoRow[]>;
  allRepos(): Promise<CodeRepoRow[]>;
  branch(repoId: string, branch: string): Promise<CodeBranchRow | undefined>;

  missingBlobs(hashes: string[]): Promise<string[]>;
  storeBlobs(blobs: { hash: string; content: Buffer }[], ts: string): Promise<number>;
  ensureUnits(
    units: { id: string; blob_hash: string; path: string; lang: string }[],
    ts: string,
  ): Promise<void>;
  unparsedUnits(ids: string[], limit: number): Promise<CodeUnitSource[]>;
  // One parse, applied whole: symbols, their local structure and unresolved refs.
  storeParse(unitId: string, parse: UnitParse, ts: string): Promise<number>;
  recordParseFailure(unitId: string, error: string, ts: string): Promise<void>;

  // Makes `files` the branch's live set. A path whose parse changed or that is gone gets its
  // row invalidated, never deleted.
  commitBranch(input: {
    repoId: string;
    branch: string;
    commit: string | null;
    dirty: boolean;
    files: { path: string; unit_id: string }[];
    ts: string;
  }): Promise<BranchFileChange>;
  seeBranches(repoId: string, branches: string[], ts: string): Promise<void>;
  retireUnseen(repoId: string, keep: string[], seenBefore: string, ts: string): Promise<string[]>;

  symbolsByName(scopes: BranchScope[], name: string, limit: number): Promise<CodeSymbolRow[]>;
  symbolsInFile(scopes: BranchScope[], path: string, limit: number): Promise<CodeSymbolRow[]>;
  symbolsByIds(scopes: BranchScope[], ids: string[]): Promise<CodeSymbolRow[]>;
  symbolDetail(id: string): Promise<CodeSymbolDetail | undefined>;
  // Where a parse is live: every (repo, branch) holding the unit right now.
  branchesHolding(
    unitId: string,
  ): Promise<{ remote_key: string; display_name: string; branch: string }[]>;
  directory(
    scope: BranchScope,
  ): Promise<{ id: string; path: string; name: string; qualified: string; kind: string }[]>;
  unitRefs(unitIds: string[]): Promise<Map<string, UnitRefs>>;
  callersOf(
    scope: BranchScope,
    name: string,
  ): Promise<{ unit_id: string; path: string; lang: string }[]>;
  importersOf(
    scope: BranchScope,
    name: string,
    path: string,
  ): Promise<{ unit_id: string; path: string; lang: string }[]>;
  definesOf(symbolId: string): Promise<{ src: string; dst: string }[]>;
  unitOfPath(
    scope: BranchScope,
    path: string,
  ): Promise<{ unit_id: string; lang: string } | undefined>;

  textSearch(
    scopes: BranchScope[],
    text: TextQuery,
    cap: number,
  ): Promise<(CodeSymbolRow & { text_rank: number })[]>;
  vectorSearch(
    scopes: BranchScope[],
    embedding: number[],
    cap: number,
  ): Promise<(CodeSymbolRow & { distance: number })[]>;

  insertRef(ref: CodeRefRow, ts: string): Promise<void>;
  resolveRefs(srcIds: string[], scopes: BranchScope[]): Promise<ResolvedCodeRef[]>;

  pendingEmbeddings(limit: number): Promise<{ embed_hash: string; text: string }[]>;
  commitVectors(
    items: { embed_hash: string; vector: number[] }[],
    model: string,
    version: string,
    ts: string,
  ): Promise<void>;
  embeddingBacklog(): Promise<number>;
}
