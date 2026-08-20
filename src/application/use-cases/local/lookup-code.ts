import {
  LOOKUP_CODE,
  useCase,
  type LookupCode,
  type LookupCodeArgs,
  type LookupCodeResult,
} from "@/application/use-cases/contracts";
import { CodeRepo } from "@/db/repositories";

@useCase(LOOKUP_CODE)
export class LocalLookupCode implements LookupCode {
  constructor(private readonly code: CodeRepo) {}

  invoke(args: LookupCodeArgs): Promise<LookupCodeResult> {
    if (!args.name && !args.file) {
      throw new Error("provide `name` (resolve a symbol) or `file` (list a file's symbols).");
    }

    return Promise.resolve({
      symbols: args.name
        ? this.code.findSymbolsByName(args.name, args.repo, args.limit)
        : this.code.findSymbolsInFile(args.repo, args.file!, args.limit),
    });
  }
}
