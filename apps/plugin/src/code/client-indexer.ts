import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  looksBinary,
  MAX_BYTES,
  sha256Hex,
  UPLOAD_FRAME_BYTES,
  type CodeCommitArgs,
  type CodeCommitResult,
  type CodeManifestArgs,
  type CodeManifestResult,
  type CodeUploadArgs,
  type CodeUploadBlob,
  type CodeUploadResult,
} from "@cerebrium/contracts/code";
import { listBranches, listIndexable, readCheckout, type Checkout } from "@plugin/src/code/git";

const MANIFEST_CHUNK = 5_000;

export interface CodeCalls {
  manifest(args: CodeManifestArgs): Promise<CodeManifestResult>;
  upload(args: CodeUploadArgs): Promise<CodeUploadResult>;
  commit(args: CodeCommitArgs): Promise<CodeCommitResult>;
}

export interface IndexedCheckout {
  checkout: Checkout;
  result: CodeCommitResult;
  listed: number;
  uploaded: number;
  skipped: number;
  rejected: { path: string; reason: string }[];
}

interface LocalFile {
  path: string;
  hash: string;
  content: Buffer;
}

// Indexes one checkout on the host: hash every indexable file, upload only what the host
// lacks, then name the branch's file list. The host parses; nothing here does.
export async function indexCheckout(
  dir: string,
  session_id: string,
  calls: CodeCalls,
): Promise<IndexedCheckout> {
  const checkout = await readCheckout(dir);
  const paths = await listIndexable(checkout.root);
  const files: LocalFile[] = [];
  let skipped = 0;

  for (const path of paths) {
    const file = await readIndexable(checkout.root, path);

    if (file) files.push(file);
    else skipped++;
  }

  const missing = new Set<string>();

  for (let i = 0; i < files.length; i += MANIFEST_CHUNK) {
    const hashes = [...new Set(files.slice(i, i + MANIFEST_CHUNK).map((f) => f.hash))];

    for (const hash of (await calls.manifest({ session_id, hashes })).missing) missing.add(hash);
  }

  const rejectedHashes = new Map<string, string>();
  let uploaded = 0;
  let frame: CodeUploadBlob[] = [];
  let frameBytes = 0;

  const flush = async (): Promise<void> => {
    if (!frame.length) return;

    const answer = await calls.upload({ session_id, blobs: frame });

    uploaded += answer.stored + answer.known;

    for (const r of answer.rejected) rejectedHashes.set(r.hash, r.reason);

    frame = [];
    frameBytes = 0;
  };

  const sent = new Set<string>();

  for (const file of files) {
    if (!missing.has(file.hash) || sent.has(file.hash)) continue;

    sent.add(file.hash);

    const content = gzipSync(file.content).toString("base64");

    if (content.length > UPLOAD_FRAME_BYTES * 1.75) {
      rejectedHashes.set(file.hash, "too large to upload in one frame");
      continue;
    }

    if (frameBytes + content.length > UPLOAD_FRAME_BYTES) await flush();

    frame.push({ hash: file.hash, content });
    frameBytes += content.length;
  }

  await flush();

  const kept = files.filter((f) => !rejectedHashes.has(f.hash));
  const rejected = files
    .filter((f) => rejectedHashes.has(f.hash))
    .map((f) => ({ path: f.path, reason: rejectedHashes.get(f.hash)! }));

  const result = await calls.commit({
    session_id,
    remote_key: checkout.remote_key,
    display_name: checkout.display_name,
    default_branch: checkout.default_branch,
    branch: checkout.branch,
    commit: checkout.commit,
    dirty: checkout.dirty,
    files: kept.map((f) => ({ path: f.path, hash: f.hash })),
    branches: await listBranches(checkout.root),
    skipped: skipped + rejected.length,
  });

  return {
    checkout,
    result,
    listed: paths.length,
    uploaded,
    skipped: skipped + rejected.length,
    rejected,
  };
}

async function readIndexable(root: string, path: string): Promise<LocalFile | null> {
  const abs = join(root, path);

  try {
    const info = await stat(abs);

    if (!info.isFile() || info.size > MAX_BYTES) return null;

    const content = await readFile(abs);

    if (looksBinary(content)) return null;

    return { path, hash: sha256Hex(content), content };
  } catch {
    return null;
  }
}
