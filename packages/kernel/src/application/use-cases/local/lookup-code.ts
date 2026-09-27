import { inject } from "tsyringe";
import { CODE_REPO_TOKEN, type CodeRepo } from "@/domain/ports/storage";
import {
  LOOKUP_CODE,
  useCase,
  type LookupCode,
  type LookupCodeArgs,
  type LookupCodeResult,
} from "@/application/use-cases/contracts";

@useCase(LOOKUP_CODE)
export class LocalLookupCode implements LookupCode {
  constructor(@inject(CODE_REPO_TOKEN) private readonly code: CodeRepo) {}

  async invoke(args: LookupCodeArgs): Promise<LookupCodeResult> {
    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    return Promise.resolve({
      symbols: args.name
        ? await this.code.findSymbolsByName(args.name, args.repo, args.limit)
        : await this.code.findSymbolsInFile(args.repo, args.file!, args.limit),
    });
  }
}
