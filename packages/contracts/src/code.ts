import { createHash } from "node:crypto";

// What a code file is, as both ends of the per-branch index see it: the plugin decides what
// to upload with these rules, and the kernel parses with the same registry. Pure data and
// node builtins only, because the plugin bundle may carry nothing else.

export interface LangDef {
  lang: string;
  wasm: string;
  // Resolve from the kernel's src/code/vendor instead of tree-sitter-wasms/out.
  vendored?: boolean;
}

const CPP = "tree-sitter-cpp.wasm";

const BY_EXT: Record<string, LangDef> = {
  ".ts": { lang: "typescript", wasm: "tree-sitter-typescript.wasm" },
  ".mts": { lang: "typescript", wasm: "tree-sitter-typescript.wasm" },
  ".cts": { lang: "typescript", wasm: "tree-sitter-typescript.wasm" },
  ".tsx": { lang: "tsx", wasm: "tree-sitter-tsx.wasm" },
  ".js": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".mjs": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".cjs": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".jsx": { lang: "javascript", wasm: "tree-sitter-javascript.wasm" },
  ".php": { lang: "php", wasm: "tree-sitter-php.wasm" },
  ".rs": { lang: "rust", wasm: "tree-sitter-rust.wasm" },
  ".c": { lang: "c", wasm: "tree-sitter-c.wasm" },
  // `.h` is ambiguous C/C++/Objective-C; the C++ grammar accepts nearly all C, while
  // the C grammar turns every `class` in a C++ header into an ERROR node.
  ".h": { lang: "c", wasm: CPP },
  ".cpp": { lang: "cpp", wasm: CPP },
  ".cc": { lang: "cpp", wasm: CPP },
  ".cxx": { lang: "cpp", wasm: CPP },
  ".hpp": { lang: "cpp", wasm: CPP },
  ".hh": { lang: "cpp", wasm: CPP },
  ".hxx": { lang: "cpp", wasm: CPP },
  ".ipp": { lang: "cpp", wasm: CPP },
  ".tpp": { lang: "cpp", wasm: CPP },
  ".inl": { lang: "cpp", wasm: CPP },
  // tree-sitter-wasms' Lua build mis-parses every file after the first one in a
  // process; packages/kernel/src/code/vendor/README.md has the detail.
  ".lua": { lang: "lua", wasm: "tree-sitter-lua.wasm", vendored: true },
  // X-Ray/S.T.A.L.K.E.R. game logic is Lua under a different extension.
  ".script": { lang: "lua", wasm: "tree-sitter-lua.wasm", vendored: true },
};

export function langForPath(path: string): LangDef | undefined {
  const dot = path.lastIndexOf(".");

  if (dot < 0) {
    return undefined;
  }

  return BY_EXT[path.slice(dot).toLowerCase()];
}

// Directories never worth indexing, independent of .gitignore.
export const SKIP_DIRS = new Set([
  "node_modules",
  // Composer's third-party tree: one PHP repo once put 98,748 Laravel symbols in the mirror.
  "vendor",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".turbo",
  ".cache",
  ".vscode-test",
]);

// Generated files that carry a known grammar but no authored code.
export const SKIP_FILES = [/^_ide_helper/];

export const MAX_BYTES = 1_000_000;

// A source occasionally carries a NUL inside a string literal; only a high NUL fraction
// marks a binary.
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);

  if (n === 0) {
    return false;
  }

  let nulls = 0;

  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) nulls++;
  }

  return nulls / n > 0.1;
}

// A repo-relative posix path worth indexing by name alone: a known grammar, no skipped
// directory on the way, not a generated file.
export function isIndexablePath(path: string): boolean {
  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? "";

  if (!langForPath(file)) return false;

  if (SKIP_FILES.some((re) => re.test(file))) return false;

  return !parts.slice(0, -1).some((dir) => SKIP_DIRS.has(dir));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// A repo's identity across machines: `host/owner/repo`, lowercase, no scheme, user or
// `.git`. `resolveHost` maps an SSH alias to the host it stands for (`ssh -G`); without it
// the alias is kept, and shows up in `display_name` where a mismatch is visible.
export function normalizeRemote(
  url: string,
  resolveHost: (host: string) => string = (h) => h,
): string | null {
  const raw = url.trim();

  if (!raw.length) return null;

  let host: string;
  let path: string;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw);

  if (scheme) {
    host = scheme[2]!;
    path = scheme[3]!;
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw);

    if (!scp) return null;

    host = scp[1]!;
    path = scp[2]!;
  }

  const segments = path
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length);

  if (!segments.length) return null;

  return [resolveHost(host), ...segments].join("/").toLowerCase();
}

export function displayNameOf(remoteKey: string): string {
  return remoteKey.split("/").pop() ?? remoteKey;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// A deterministic id in ULID shape (26 Crockford chars, first one 0-7), so it passes every
// tool schema that validates node ids.
export function ulidShaped(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  let i = 0;

  const take = (n: number): number => {
    while (bits < n) {
      value = (value << 8) | bytes[i++]!;
      bits += 8;
    }

    bits -= n;

    const v = (value >> bits) & ((1 << n) - 1);

    value &= (1 << bits) - 1;

    return v;
  };

  out += CROCKFORD.charAt(take(3));

  while (out.length < 26) out += CROCKFORD.charAt(take(5));

  return out;
}

export function codeUnitId(blobHash: string, path: string): string {
  return sha256Hex(`${blobHash}\0${path}`).slice(0, 32);
}

export function codeSymbolId(unitId: string, qualified: string, kind: string): string {
  return ulidShaped(`${unitId}\0${qualified}\0${kind}`);
}

// The repo and branch a call's code reads are scoped to. The plugin fills it from the
// working directory; the kernel never infers one.
export interface CodeContext {
  remote_key: string;
  branch: string;
}

export interface CodeFileEntry {
  path: string;
  hash: string;
}

export interface CodeRepoDescriptor {
  remote_key: string;
  display_name?: string;
  default_branch?: string | null;
}

export interface CodeManifestArgs {
  session_id: string;
  hashes: string[];
}

export interface CodeManifestResult {
  missing: string[];
}

export interface CodeUploadBlob {
  hash: string;
  // gzip, then base64.
  content: string;
}

export interface CodeUploadArgs {
  session_id: string;
  blobs: CodeUploadBlob[];
}

export interface CodeUploadResult {
  stored: number;
  known: number;
  rejected: { hash: string; reason: string }[];
}

export interface CodeCommitArgs extends CodeRepoDescriptor {
  session_id: string;
  branch: string;
  commit?: string | null;
  dirty?: boolean;
  files: CodeFileEntry[];
  // Every branch the repo still has, local and remote-tracking; a branch missing from it
  // long enough is retired.
  branches?: string[];
  skipped?: number;
}

export interface CodeCommitResult {
  remote_key: string;
  branch: string;
  commit: string | null;
  files: number;
  files_changed: number;
  files_removed: number;
  units_parsed: number;
  parse_failures: number;
  symbols_added: number;
  branches_retired: string[];
  duration_ms: number;
}

// One frame of uploads stays well under the kernel's 1 MB line cap.
export const UPLOAD_FRAME_BYTES = 512 * 1024;

export interface CodeImportRef {
  name: string;
  candidatePaths: string[];
  namespace: boolean;
  byName?: boolean;
}

export interface CodeCallRef {
  srcQualified: string;
  callee: string;
}
