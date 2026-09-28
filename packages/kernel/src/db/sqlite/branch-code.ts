import { injectable } from "tsyringe";
import { BackendCapabilityError, type BranchCodeRepo } from "@/domain/ports/storage";

function refuse(): never {
  throw new BackendCapabilityError("the per-branch code index", "sqlite");
}

@injectable()
export class SqliteBranchCodeRepo implements BranchCodeRepo {
  async upsertRepo(): Promise<never> {
    return refuse();
  }

  async repoByKey(): Promise<never> {
    return refuse();
  }

  async reposNamed(): Promise<never> {
    return refuse();
  }

  async allRepos(): Promise<never> {
    return refuse();
  }

  async branch(): Promise<never> {
    return refuse();
  }

  async missingBlobs(): Promise<never> {
    return refuse();
  }

  async storeBlobs(): Promise<never> {
    return refuse();
  }

  async ensureUnits(): Promise<never> {
    return refuse();
  }

  async unparsedUnits(): Promise<never> {
    return refuse();
  }

  async storeParse(): Promise<never> {
    return refuse();
  }

  async recordParseFailure(): Promise<never> {
    return refuse();
  }

  async commitBranch(): Promise<never> {
    return refuse();
  }

  async seeBranches(): Promise<never> {
    return refuse();
  }

  async retireUnseen(): Promise<never> {
    return refuse();
  }

  async symbolsByName(): Promise<never> {
    return refuse();
  }

  async symbolsInFile(): Promise<never> {
    return refuse();
  }

  async symbolsByIds(): Promise<never> {
    return refuse();
  }

  async symbolDetail(): Promise<never> {
    return refuse();
  }

  async branchesHolding(): Promise<never> {
    return refuse();
  }

  async directory(): Promise<never> {
    return refuse();
  }

  async unitRefs(): Promise<never> {
    return refuse();
  }

  async callersOf(): Promise<never> {
    return refuse();
  }

  async importersOf(): Promise<never> {
    return refuse();
  }

  async definesOf(): Promise<never> {
    return refuse();
  }

  async unitOfPath(): Promise<never> {
    return refuse();
  }

  async textSearch(): Promise<never> {
    return refuse();
  }

  async vectorSearch(): Promise<never> {
    return refuse();
  }

  async insertRef(): Promise<never> {
    return refuse();
  }

  async resolveRefs(): Promise<never> {
    return refuse();
  }

  async pendingEmbeddings(): Promise<never> {
    return refuse();
  }

  async commitVectors(): Promise<never> {
    return refuse();
  }

  async embeddingBacklog(): Promise<never> {
    return refuse();
  }
}
