import type {
  CodeCommitArgs,
  CodeCommitResult,
  CodeManifestArgs,
  CodeManifestResult,
  CodeUploadArgs,
  CodeUploadResult,
} from "@cerebrium/contracts/code";
import { useCaseToken, type UseCase } from "@/application/use-cases/contracts/use-case";

// The three steps a client takes to index a branch on the host: ask which contents it
// lacks, upload them, then name the branch's file list.
export type CodeManifest = UseCase<CodeManifestArgs, CodeManifestResult>;
export type CodeUpload = UseCase<CodeUploadArgs, CodeUploadResult>;
export type CodeCommit = UseCase<CodeCommitArgs, CodeCommitResult>;

export const CODE_MANIFEST = useCaseToken<CodeManifestArgs, CodeManifestResult>("CodeManifest");
export const CODE_UPLOAD = useCaseToken<CodeUploadArgs, CodeUploadResult>("CodeUpload");
export const CODE_COMMIT = useCaseToken<CodeCommitArgs, CodeCommitResult>("CodeCommit");
