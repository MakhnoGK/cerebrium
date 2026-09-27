import type {
  FileIndexInput,
  FileIndexResult,
  RepoProvenance,
  SymbolDirEntry,
  SymbolFacets,
  SymbolLookup,
} from "@cerebrium/contracts/types";
import type { EdgeType } from "@cerebrium/contracts/vocab";

export const CODE_REPO_TOKEN = Symbol("CodeRepo");

export interface CodeRepo {
  codeFileHash(repo: string, path: string): Promise<string | undefined>;
  listCodeFilePaths(repo: string): Promise<string[]>;
  applyFileIndex(input: FileIndexInput): Promise<FileIndexResult>;
  repoSymbolDirectory(repo: string): Promise<SymbolDirEntry[]>;
  rebuildResolvedEdges(
    repo: string,
    path: string,
    type: EdgeType,
    pairs: { src: string; dst: string }[],
    session_id: string,
    ts: string,
  ): Promise<number>;
  removeFile(repo: string, path: string, ts: string): Promise<number>;
  symbolDetail(nodeId: string): Promise<(SymbolFacets & { source: string }) | undefined>;
  findSymbolsByName(name: string, repo: string | undefined, limit: number): Promise<SymbolLookup[]>;
  findSymbolsInFile(repo: string | undefined, path: string, limit: number): Promise<SymbolLookup[]>;
  setRepoProvenance(
    repo: string,
    root: string | null,
    branch: string | null,
    commit: string | null,
    dirty: boolean,
    ts: string,
  ): Promise<void>;
  repoProvenance(repo: string): Promise<RepoProvenance | undefined>;
  storedRepoRoots(): Promise<{ name: string; root: string }[]>;
  allRepoProvenance(): Promise<RepoProvenance[]>;
}
