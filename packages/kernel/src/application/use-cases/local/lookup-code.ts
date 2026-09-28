import { inject } from "tsyringe";
import { CODE_REPO_TOKEN, STORE_TOKEN, type CodeRepo, type Store } from "@/domain/ports/storage";
import { CodeReadService } from "@/application/services";
import {
  LOOKUP_CODE,
  useCase,
  type LookupCode,
  type LookupCodeArgs,
  type LookupCodeResult,
} from "@/application/use-cases/contracts";

@useCase(LOOKUP_CODE)
export class LocalLookupCode implements LookupCode {
  constructor(
    @inject(CODE_REPO_TOKEN) private readonly code: CodeRepo,
    @inject(STORE_TOKEN) private readonly store: Store,
    private readonly branches: CodeReadService,
  ) {}

  async invoke(args: LookupCodeArgs): Promise<LookupCodeResult> {
    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    if (this.store.capabilities.branchCode) {
      const { scopes, notes } = await this.branches.scopes({
        ...(args.code_context === undefined ? {} : { code_context: args.code_context }),
        ...(args.repo === undefined ? {} : { repo: args.repo }),
        ...(args.branch === undefined ? {} : { branch: args.branch }),
      });

      return {
        symbols: args.name
          ? await this.branches.lookupByName(scopes, args.name, args.limit)
          : await this.branches.lookupInFile(scopes, args.file!, args.limit),
        notes,
      };
    }

    return {
      symbols: args.name
        ? await this.code.findSymbolsByName(args.name, args.repo, args.limit)
        : await this.code.findSymbolsInFile(args.repo, args.file!, args.limit),
    };
  }
}
