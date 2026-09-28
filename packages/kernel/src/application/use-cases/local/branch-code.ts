import type {
  CodeCommitArgs,
  CodeCommitResult,
  CodeManifestArgs,
  CodeManifestResult,
  CodeUploadArgs,
  CodeUploadResult,
} from "@cerebrium/contracts/code";
import { BranchCodeService } from "@/application/services";
import {
  CODE_COMMIT,
  CODE_MANIFEST,
  CODE_UPLOAD,
  useCase,
  type CodeCommit,
  type CodeManifest,
  type CodeUpload,
} from "@/application/use-cases/contracts";

@useCase(CODE_MANIFEST)
export class LocalCodeManifest implements CodeManifest {
  constructor(private readonly code: BranchCodeService) {}

  invoke(args: CodeManifestArgs): Promise<CodeManifestResult> {
    return this.code.manifest(args);
  }
}

@useCase(CODE_UPLOAD)
export class LocalCodeUpload implements CodeUpload {
  constructor(private readonly code: BranchCodeService) {}

  invoke(args: CodeUploadArgs): Promise<CodeUploadResult> {
    return this.code.upload(args);
  }
}

@useCase(CODE_COMMIT)
export class LocalCodeCommit implements CodeCommit {
  constructor(private readonly code: BranchCodeService) {}

  invoke(args: CodeCommitArgs): Promise<CodeCommitResult> {
    return this.code.commit(args);
  }
}
