import { gunzipSync } from "node:zlib";
import { inject, injectable } from "tsyringe";
import {
  codeUnitId,
  displayNameOf,
  isIndexablePath,
  langForPath,
  looksBinary,
  MAX_BYTES,
  sha256Hex,
  type CodeCommitArgs,
  type CodeCommitResult,
  type CodeManifestArgs,
  type CodeManifestResult,
  type CodeUploadArgs,
  type CodeUploadResult,
} from "@cerebrium/contracts/code";
import { CLOCK_TOKEN, type Clock } from "@/domain/ports/clock";
import { CODE_PARSER_TOKEN, type CodeParser } from "@/domain/ports/code-parser";
import {
  BackendCapabilityError,
  BRANCH_CODE_REPO_TOKEN,
  STORE_TOKEN,
  type BranchCodeRepo,
  type Store,
} from "@/domain/ports/storage";

const PARSE_BATCH = 16;
const MAX_UPLOAD_BLOBS = 500;
const MAX_MANIFEST_HASHES = 50_000;
export const BRANCH_RETIRE_MS = 14 * 86_400_000;

const utf8 = new TextDecoder("utf-8", { fatal: true });

// The write side of the per-branch index: which contents the host lacks, storing them, and
// making a client's file list a branch's live set.
@injectable()
export class BranchCodeService {
  constructor(
    @inject(BRANCH_CODE_REPO_TOKEN) private readonly code: BranchCodeRepo,
    @inject(CODE_PARSER_TOKEN) private readonly parser: CodeParser,
    @inject(STORE_TOKEN) private readonly store: Store,
    @inject(CLOCK_TOKEN) private readonly clock: Clock,
  ) {}

  async manifest(args: CodeManifestArgs): Promise<CodeManifestResult> {
    this.requireBackend();

    if (args.hashes.length > MAX_MANIFEST_HASHES) {
      throw new Error(`a manifest names at most ${String(MAX_MANIFEST_HASHES)} hashes`);
    }

    return { missing: await this.code.missingBlobs(args.hashes.filter(isHash)) };
  }

  async upload(args: CodeUploadArgs): Promise<CodeUploadResult> {
    this.requireBackend();

    if (args.blobs.length > MAX_UPLOAD_BLOBS) {
      throw new Error(`an upload carries at most ${String(MAX_UPLOAD_BLOBS)} blobs`);
    }

    const rejected: CodeUploadResult["rejected"] = [];
    const accepted: { hash: string; content: Buffer }[] = [];

    for (const blob of args.blobs) {
      const reason = decode(blob.hash, blob.content, accepted);

      if (reason !== null) rejected.push({ hash: blob.hash, reason });
    }

    const stored = await this.code.storeBlobs(accepted, this.clock.now());

    return { stored, known: accepted.length - stored, rejected };
  }

  async commit(args: CodeCommitArgs): Promise<CodeCommitResult> {
    this.requireBackend();

    const started = Date.parse(this.clock.now());
    const now = this.clock.now();

    validateCommit(args);

    const missing = await this.code.missingBlobs(args.files.map((f) => f.hash));

    if (missing.length) {
      throw new Error(
        `${String(missing.length)} file content(s) were never uploaded; send them with ` +
          "code_upload before committing the branch.",
      );
    }

    const repo = await this.code.upsertRepo(
      {
        remote_key: args.remote_key,
        display_name: args.display_name ?? displayNameOf(args.remote_key),
        default_branch: args.default_branch ?? null,
      },
      now,
    );
    const units = args.files.map((f) => ({
      id: codeUnitId(f.hash, f.path),
      blob_hash: f.hash,
      path: f.path,
      lang: langForPath(f.path)!.lang,
    }));

    await this.code.ensureUnits(units, now);

    const parsed = await this.parseAll(units.map((u) => u.id));
    const change = await this.code.commitBranch({
      repoId: repo.id,
      branch: args.branch,
      commit: args.commit ?? null,
      dirty: args.dirty ?? false,
      files: units.map((u) => ({ path: u.path, unit_id: u.id })),
      ts: now,
    });

    let retired: string[] = [];

    if (args.branches !== undefined) {
      await this.code.seeBranches(repo.id, args.branches, now);

      retired = await this.code.retireUnseen(
        repo.id,
        [args.branch, ...(repo.default_branch === null ? [] : [repo.default_branch])],
        new Date(Date.parse(now) - BRANCH_RETIRE_MS).toISOString(),
        now,
      );
    }

    return {
      remote_key: repo.remote_key,
      branch: args.branch,
      commit: args.commit ?? null,
      files: units.length,
      files_changed: change.changed,
      files_removed: change.removed,
      units_parsed: parsed.units,
      parse_failures: parsed.failures,
      symbols_added: parsed.symbols,
      branches_retired: retired,
      duration_ms: Math.max(0, Date.parse(this.clock.now()) - started),
    };
  }

  private async parseAll(
    ids: string[],
  ): Promise<{ units: number; failures: number; symbols: number }> {
    const tally = { units: 0, failures: 0, symbols: 0 };

    for (;;) {
      const batch = await this.code.unparsedUnits(ids, PARSE_BATCH);

      if (!batch.length) return tally;

      const outcomes = await this.parser.parse(
        batch.map((u) => ({ path: u.path, content: u.content })),
      );

      for (const [i, unit] of batch.entries()) {
        const outcome = outcomes[i];
        const ts = this.clock.now();

        if (outcome?.ok) {
          try {
            tally.symbols += await this.code.storeParse(unit.id, outcome.parse, ts);
            tally.units++;

            continue;
          } catch (err) {
            await this.code.recordParseFailure(unit.id, (err as Error).message, ts);
          }
        } else {
          await this.code.recordParseFailure(unit.id, outcome?.error ?? "no parse result", ts);
        }

        tally.failures++;
      }
    }
  }

  private requireBackend(): void {
    if (!this.store.capabilities.branchCode) {
      throw new BackendCapabilityError("the per-branch code index", this.store.backend);
    }
  }
}

function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function decode(
  hash: string,
  content: string,
  into: { hash: string; content: Buffer }[],
): string | null {
  if (!isHash(hash)) return "not a sha256 hex digest";

  let raw: Buffer;

  try {
    raw = gunzipSync(Buffer.from(content, "base64"), { maxOutputLength: MAX_BYTES + 1 });
  } catch {
    return "not gzip+base64, or larger than the size limit";
  }

  if (raw.length > MAX_BYTES) return "larger than the size limit";

  if (sha256Hex(raw) !== hash) return "content does not match its hash";

  if (looksBinary(raw)) return "binary content";

  try {
    utf8.decode(raw);
  } catch {
    return "not UTF-8";
  }

  into.push({ hash, content: raw });

  return null;
}

function validateCommit(args: CodeCommitArgs): void {
  if (
    !/^[^\s/]+(\/[^\s/]+)+$/.test(args.remote_key) ||
    args.remote_key !== args.remote_key.toLowerCase()
  ) {
    throw new Error(`'${args.remote_key}' is not a normalized remote key (host/owner/repo)`);
  }

  if (!args.branch.trim().length || args.branch.length > 255) {
    throw new Error("a commit names the branch it indexes");
  }

  const seen = new Set<string>();

  for (const f of args.files) {
    if (
      f.path.startsWith("/") ||
      f.path.split("/").some((part) => part === ".." || part === "." || part === "") ||
      !isIndexablePath(f.path)
    ) {
      throw new Error(`'${f.path}' is not an indexable repo-relative path`);
    }

    if (!isHash(f.hash)) throw new Error(`'${f.hash}' is not a sha256 hex digest`);

    if (seen.has(f.path)) throw new Error(`'${f.path}' is listed twice`);

    seen.add(f.path);
  }
}
