import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "@test/helpers";
import { indexRepo } from "@/code/indexer";
import type { EmbeddingWorker } from "@/embeddings/worker";

const CRYPTO = `/** Hash a token deterministically. */
export function hashToken(input: string): string {
  return input.split("").reverse().join("");
}
export enum Algo { SHA256, SHA512 }
`;

const AUTH = `import { Injectable } from "@nestjs/common";
import { hashToken } from "../util/crypto";

/** Auth business logic. */
@Injectable()
export class AuthService {
  /** Validate a login. */
  validate(pw: string): boolean {
    return hashToken(pw).length > 0;
  }
  issue(pw: string): string {
    return this.validate(pw) ? "token" : "";
  }
}
export const TOKEN_TTL = 900;
`;

let root: string;
function write(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

async function drain(worker: EmbeddingWorker): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await worker.tick();
    if (r.embedded === 0 && r.failed === 0) break;
  }
}

const NAME = "demo";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mk-index-"));
  write("util/crypto.ts", CRYPTO);
  write("auth/auth.service.ts", AUTH);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function opts(now: () => string) {
  return { session_id: "sys-index", now };
}

describe("indexer — incremental hash-gate", () => {
  it("indexes a fresh repo, then a no-op re-index adds/updates/re-embeds nothing", async () => {
    const { repo, clock, worker } = makeCtx();
    const first = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(first.files_indexed).toBe(2);
    expect(first.symbols_added).toBeGreaterThan(4);
    await drain(worker);
    expect(repo.embeddingStats().backlog).toBe(0);

    clock.advanceDays(1);
    const again = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(again.files_indexed).toBe(0);
    expect(again.files_skipped).toBe(2);
    expect(again).toMatchObject({ symbols_added: 0, symbols_updated: 0, symbols_invalidated: 0 });
    expect(repo.embeddingStats().backlog).toBe(0); // nothing re-enqueued
  });

  it("editing one symbol re-embeds only it; siblings keep ids + embeddings", async () => {
    const { repo, clock, worker, db } = makeCtx();
    await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    await drain(worker);

    const idOf = (q: string) =>
      (db.prepare("SELECT node_id FROM symbols WHERE qualified = ?").get(q) as { node_id: string })
        .node_id;
    const validateId = idOf("auth/auth.service.ts:AuthService.validate");
    const issueId = idOf("auth/auth.service.ts:AuthService.issue");
    const cryptoFnId = idOf("util/crypto.ts:hashToken");

    // Change validate's doc + body (its summary changes -> it re-embeds).
    write(
      "auth/auth.service.ts",
      AUTH.replace("/** Validate a login. */", "/** Validate a login attempt securely. */").replace(
        "return hashToken(pw).length > 0;",
        "return hashToken(pw).length > 1;",
      ),
    );
    clock.advanceDays(1);
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(res.files_indexed).toBe(1); // only auth.service.ts reparsed; crypto.ts hash-gated
    expect(res.files_skipped).toBe(1);

    const rev = (id: string) =>
      (db.prepare("SELECT MAX(rev) AS m FROM revisions WHERE node_id = ?").get(id) as { m: number })
        .m;
    const pending = (id: string) =>
      (db.prepare("SELECT pending_embedding AS p FROM nodes WHERE id = ?").get(id) as { p: number })
        .p;

    expect(rev(validateId)).toBe(2);
    expect(pending(validateId)).toBe(1); // re-enqueued for embedding
    expect(rev(issueId)).toBe(1); // sibling method untouched
    expect(pending(issueId)).toBe(0);
    expect(rev(cryptoFnId)).toBe(1); // other file untouched
    expect(pending(cryptoFnId)).toBe(0);
  });

  it("deleting a symbol from a file invalidates it (soft); it survives via history", async () => {
    const { repo, clock, db } = makeCtx();
    await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    const ttlId = (
      db
        .prepare("SELECT node_id FROM symbols WHERE qualified = ?")
        .get("auth/auth.service.ts:TOKEN_TTL") as { node_id: string }
    ).node_id;

    write("auth/auth.service.ts", AUTH.replace("export const TOKEN_TTL = 900;", ""));
    clock.advanceDays(1);
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(res.symbols_invalidated).toBeGreaterThanOrEqual(1);

    const row = db.prepare("SELECT invalidated_at FROM nodes WHERE id = ?").get(ttlId) as {
      invalidated_at: string | null;
    };
    expect(row.invalidated_at).not.toBeNull();
    expect(repo.fullNode(ttlId)).toBeDefined(); // reachable, not hard-deleted
  });

  it("deleting a whole file invalidates its symbols and drops its code_files row", async () => {
    const { repo, clock } = makeCtx();
    await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    rmSync(join(root, "util/crypto.ts"));
    clock.advanceDays(1);
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(res.symbols_invalidated).toBeGreaterThanOrEqual(1);
    expect(repo.codeFileHash(NAME, "util/crypto.ts")).toBeUndefined();
    expect(repo.findSymbolsInFile(NAME, "util/crypto.ts", 25)).toHaveLength(0);
  });
});

describe("indexer — edges", () => {
  it("creates defines, cross-file imports, and best-effort calls; drops unresolved imports", async () => {
    const { repo, clock, db } = makeCtx();
    await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );

    const idOf = (q: string) =>
      (db.prepare("SELECT node_id FROM symbols WHERE qualified = ?").get(q) as { node_id: string })
        .node_id;
    const authMod = idOf("auth/auth.service.ts");
    const cls = idOf("auth/auth.service.ts:AuthService");
    const validate = idOf("auth/auth.service.ts:AuthService.validate");
    const issue = idOf("auth/auth.service.ts:AuthService.issue");
    const hashToken = idOf("util/crypto.ts:hashToken");

    const edge = (src: string, dst: string, type: string) =>
      db
        .prepare(
          "SELECT provenance FROM edges WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL",
        )
        .get(src, dst, type) as { provenance: string } | undefined;

    expect(edge(cls, validate, "defines")?.provenance).toBe("system");
    expect(edge(authMod, hashToken, "imports")?.provenance).toBe("system"); // cross-file resolved
    expect(edge(validate, hashToken, "calls")?.provenance).toBe("system"); // imported-symbol call
    expect(edge(issue, validate, "calls")?.provenance).toBe("system"); // same-file this.method() call

    // The bare `@nestjs/common` import produced no edge -> exactly one imports edge from the module.
    const importCount = db
      .prepare(
        "SELECT COUNT(*) AS c FROM edges WHERE src = ? AND type = 'imports' AND invalidated_at IS NULL",
      )
      .get(authMod) as { c: number };
    expect(importCount.c).toBe(1);
  });
});

const PHP_HASHER = `<?php
namespace App\\Util;
class Hasher {
  public static function hash(string $s): string { return strrev($s); }
}
`;
const PHP_AUTH = `<?php
namespace App\\Service;
use App\\Util\\Hasher;
class AuthService {
  public function validate(string $pw): bool { return Hasher::hash($pw) !== ''; }
}
`;

describe("indexer — PHP", () => {
  it("indexes PHP and resolves by-name imports/calls across files", async () => {
    const { repo, clock, db } = makeCtx();
    write("src/Util/Hasher.php", PHP_HASHER);
    write("src/Service/AuthService.php", PHP_AUTH);
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(res.files_indexed).toBe(4); // 2 TS + 2 PHP

    const idOf = (q: string) =>
      (db.prepare("SELECT node_id FROM symbols WHERE qualified = ?").get(q) as { node_id: string })
        .node_id;
    const authMod = idOf("src/Service/AuthService.php");
    const hasher = idOf("src/Util/Hasher.php:Hasher");
    const validate = idOf("src/Service/AuthService.php:AuthService.validate");
    const hashM = idOf("src/Util/Hasher.php:Hasher.hash");

    const edge = (src: string, dst: string, type: string) =>
      db
        .prepare(
          "SELECT 1 FROM edges WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL",
        )
        .get(src, dst, type);
    expect(edge(authMod, hasher, "imports")).toBeTruthy(); // use App\Util\Hasher -> Hasher class, by name
    expect(edge(validate, hashM, "calls")).toBeTruthy(); // Hasher::hash() -> Hasher.hash, by name
  });
});

const RUST_UTIL = `//! Hashing helpers.
pub fn hash_token(s: &str) -> String {
    s.chars().rev().collect()
}
`;
const RUST_AUTH = `use crate::util::hash_token;

pub struct AuthService;

impl AuthService {
    pub fn validate(&self, pw: &str) -> bool {
        !hash_token(pw).is_empty()
    }
}
`;

describe("indexer — Rust", () => {
  it("indexes Rust and resolves by-name imports/calls across files", async () => {
    const { repo, clock, db } = makeCtx();
    write("src/util.rs", RUST_UTIL);
    write("src/auth.rs", RUST_AUTH);
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );
    expect(res.files_indexed).toBe(4); // 2 TS + 2 Rust

    const idOf = (q: string) =>
      (db.prepare("SELECT node_id FROM symbols WHERE qualified = ?").get(q) as { node_id: string })
        .node_id;
    const authMod = idOf("src/auth.rs");
    const hashToken = idOf("src/util.rs:hash_token");
    const validate = idOf("src/auth.rs:AuthService.validate");

    const edge = (src: string, dst: string, type: string) =>
      db
        .prepare(
          "SELECT 1 FROM edges WHERE src = ? AND dst = ? AND type = ? AND invalidated_at IS NULL",
        )
        .get(src, dst, type);
    expect(edge(authMod, hashToken, "imports")).toBeTruthy(); // use crate::util::hash_token, by name
    expect(edge(validate, hashToken, "calls")).toBeTruthy(); // hash_token(pw) call, by name
  });
});

describe("indexer — walk filters", () => {
  it("skips node_modules, dist, and .gitignore'd paths", async () => {
    const { repo, clock } = makeCtx();
    write("node_modules/dep/index.ts", "export const x = 1;");
    write("dist/bundle.ts", "export const y = 2;");
    write("secret/keys.ts", "export const k = 3;");
    write(".gitignore", "secret/\n");
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );

    expect(res.files_scanned).toBe(2); // only util/crypto.ts + auth/auth.service.ts
    expect(repo.findSymbolsByName("x", NAME, 5)).toHaveLength(0);
    expect(repo.findSymbolsByName("k", NAME, 5)).toHaveLength(0);
  });

  it("indexes source that contains a NUL byte in a string literal (not treated as binary)", async () => {
    const { repo, clock } = makeCtx();
    write(
      "nul/sep.ts",
      "export function join(a: string, b: string): string {\n  return `${a}\0${b}`;\n}\n",
    );
    const res = await indexRepo(
      repo,
      { name: NAME, root },
      opts(() => clock.t),
    );

    expect(res.files_indexed).toBe(3); // crypto + auth + nul/sep
    expect(repo.findSymbolsByName("join", NAME, 5)).toHaveLength(1);
  });
});
