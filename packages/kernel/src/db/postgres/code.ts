import { injectable } from "tsyringe";
import type {
  FileIndexResult,
  RepoProvenance,
  SymbolDirEntry,
  SymbolFacets,
  SymbolLookup,
} from "@cerebrium/contracts/types";
import { BackendCapabilityError, type CodeRepo } from "@/domain/ports/storage";

// The code mirror is not on this backend. Reads that ordinary calls make on the way past
// (fetching a node, listing repos) answer empty; indexing and lookup refuse.
@injectable()
export class PgCodeRepo implements CodeRepo {
  private refuse(): never {
    throw new BackendCapabilityError("the code index", "postgres");
  }

  async codeFileHash(): Promise<string | undefined> {
    this.refuse();
  }

  async listCodeFilePaths(): Promise<string[]> {
    this.refuse();
  }

  async applyFileIndex(): Promise<FileIndexResult> {
    this.refuse();
  }

  async repoSymbolDirectory(): Promise<SymbolDirEntry[]> {
    this.refuse();
  }

  async rebuildResolvedEdges(): Promise<number> {
    this.refuse();
  }

  async removeFile(): Promise<number> {
    this.refuse();
  }

  async symbolDetail(): Promise<(SymbolFacets & { source: string }) | undefined> {
    return undefined;
  }

  async findSymbolsByName(): Promise<SymbolLookup[]> {
    this.refuse();
  }

  async findSymbolsInFile(): Promise<SymbolLookup[]> {
    this.refuse();
  }

  async setRepoProvenance(): Promise<void> {
    this.refuse();
  }

  async repoProvenance(): Promise<RepoProvenance | undefined> {
    return undefined;
  }

  async storedRepoRoots(): Promise<{ name: string; root: string }[]> {
    return [];
  }

  async allRepoProvenance(): Promise<RepoProvenance[]> {
    return [];
  }
}
