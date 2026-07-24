import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { makeCtx } from "./helpers";
import type { ExtractedSymbol, FileIndexInput } from "@/db/repo";

const REPO = "demo";
const PATH = "auth/auth.service.ts";

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function sym(over: Partial<ExtractedSymbol> & { name: string; source: string }): ExtractedSymbol {
  const qualified = over.qualified ?? `${PATH}:${over.name}`;
  return {
    external_id:
      over.external_id ?? hash(`${REPO}\0${PATH}\0${qualified}\0${over.symbol_kind ?? "function"}`),
    symbol_kind: over.symbol_kind ?? "function",
    name: over.name,
    qualified,
    signature: over.signature ?? `function ${over.name}()`,
    summary: over.summary ?? `function ${over.name}()`,
    start_line: over.start_line ?? 1,
    end_line: over.end_line ?? 2,
    code_hash: hash(over.source),
    source: over.source,
  };
}

function fileInput(over: Partial<FileIndexInput> & { symbols: ExtractedSymbol[] }): FileIndexInput {
  return {
    repo: REPO,
    path: PATH,
    lang: "typescript",
    fileHash: hash(over.symbols.map((s) => s.source).join("|")),
    defines: over.defines ?? [],
    session_id: over.session_id ?? "sess-1",
    ts: over.ts ?? "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("phase 3b — migration + schema", () => {
  it("creates code_files and symbols tables", () => {
    const { db } = makeCtx();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('code_files','symbols')",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables.sort()).toEqual(["code_files", "symbols"]);
  });
});

describe("phase 3b — applyFileIndex diff", () => {
  it("creates mirror symbol nodes on first index and enqueues embeddings", () => {
    const { repo, db } = makeCtx();
    const mod = sym({
      name: "auth.service.ts",
      symbol_kind: "module",
      qualified: PATH,
      source: "whole file",
    });
    const cls = sym({ name: "AuthService", symbol_kind: "class", source: "class AuthService {}" });
    const res = repo.applyFileIndex(fileInput({ symbols: [mod, cls] }));

    expect(res).toMatchObject({ added: 2, updated: 0, invalidated: 0 });

    const nodes = db
      .prepare("SELECT memory_kind, type, origin, project, external_id FROM nodes")
      .all() as {
      memory_kind: string;
      type: string;
      origin: string;
      project: string;
      external_id: string;
    }[];
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.memory_kind).toBe("mirror");
      expect(n.type).toBe("symbol");
      expect(n.origin).toBe("repo");
      expect(n.project).toBe(REPO);
      expect(n.external_id).toBeTruthy();
    }
    // FTS row present; embedding queued (findable via FTS immediately, vector pending).
    const fts = db.prepare("SELECT COUNT(*) AS c FROM node_fts").get() as { c: number };
    expect(fts.c).toBe(2);
    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE pending_embedding = 1")
      .get() as { c: number };
    expect(pending.c).toBe(2);
    expect(repo.codeFileHash(REPO, PATH)).toBeTruthy();
  });

  it("hash-gate: re-applying an unchanged file set is a no-op", () => {
    const { repo } = makeCtx();
    const cls = sym({ name: "AuthService", symbol_kind: "class", source: "class AuthService {}" });
    repo.applyFileIndex(fileInput({ symbols: [cls] }));
    const again = repo.applyFileIndex(
      fileInput({ symbols: [cls], ts: "2026-01-02T00:00:00.000Z" }),
    );
    expect(again).toMatchObject({ added: 0, updated: 0, invalidated: 0 });
  });

  it("changed symbol bumps exactly that node's revision; siblings untouched", () => {
    const { repo, db } = makeCtx();
    const a = sym({ name: "alpha", source: "function alpha() { return 1; }" });
    const b = sym({ name: "beta", source: "function beta() { return 2; }" });
    repo.applyFileIndex(fileInput({ symbols: [a, b] }));

    const a2 = sym({ name: "alpha", source: "function alpha() { return 99; }" });
    const res = repo.applyFileIndex(
      fileInput({ symbols: [a2, b], ts: "2026-01-03T00:00:00.000Z" }),
    );
    expect(res).toMatchObject({ added: 0, updated: 1, invalidated: 0 });

    const rev = db.prepare(
      `SELECT MAX(r.rev) AS m FROM revisions r JOIN nodes n ON n.id = r.node_id WHERE n.external_id = ?`,
    );
    expect((rev.get(a2.external_id) as { m: number }).m).toBe(2);
    expect((rev.get(b.external_id) as { m: number }).m).toBe(1);
  });

  it("removed symbol is invalidated (soft), still reachable via history", () => {
    const { repo, db } = makeCtx();
    const a = sym({ name: "alpha", source: "function alpha() {}" });
    const b = sym({ name: "beta", source: "function beta() {}" });
    repo.applyFileIndex(fileInput({ symbols: [a, b] }));

    const res = repo.applyFileIndex(fileInput({ symbols: [a], ts: "2026-01-04T00:00:00.000Z" }));
    expect(res).toMatchObject({ invalidated: 1 });

    const bRow = db
      .prepare("SELECT id, invalidated_at FROM nodes WHERE external_id = ?")
      .get(b.external_id) as {
      id: string;
      invalidated_at: string | null;
    };
    expect(bRow.invalidated_at).toBe("2026-01-04T00:00:00.000Z");
    // node + symbols facet row survive (never hard-deleted)
    expect(repo.symbolDetail(bRow.id)).toBeDefined();
    expect(repo.fullNode(bRow.id)).toBeDefined();
  });

  it("a reappearing symbol is revived rather than duplicated", () => {
    const { repo, db } = makeCtx();
    const b = sym({ name: "beta", source: "function beta() {}" });
    repo.applyFileIndex(fileInput({ symbols: [b] }));
    repo.applyFileIndex(fileInput({ symbols: [], ts: "2026-01-02T00:00:00.000Z" })); // b removed
    const res = repo.applyFileIndex(fileInput({ symbols: [b], ts: "2026-01-03T00:00:00.000Z" })); // back
    expect(res).toMatchObject({ added: 0, updated: 1 });
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE external_id = ?")
      .get(b.external_id) as {
      c: number;
    };
    expect(count.c).toBe(1);
    const inval = db
      .prepare("SELECT invalidated_at FROM nodes WHERE external_id = ?")
      .get(b.external_id) as {
      invalidated_at: string | null;
    };
    expect(inval.invalidated_at).toBeNull();
  });
});

describe("phase 3b — code edges", () => {
  it("defines edges are written with provenance 'system'", () => {
    const { repo, db } = makeCtx();
    const cls = sym({ name: "AuthService", symbol_kind: "class", source: "class AuthService {}" });
    const m = sym({
      name: "validate",
      symbol_kind: "method",
      qualified: `${PATH}:AuthService.validate`,
      source: "validate() {}",
    });
    const res = repo.applyFileIndex(
      fileInput({ symbols: [cls, m], defines: [{ src: cls.external_id, dst: m.external_id }] }),
    );
    expect(res.edges).toBe(1);
    const edge = db.prepare("SELECT type, provenance FROM edges WHERE type = 'defines'").get() as {
      type: string;
      provenance: string;
    };
    expect(edge).toMatchObject({ type: "defines", provenance: "system" });
  });

  it("resolves cross-file imports via the repo directory; drops the unresolved", () => {
    const { repo } = makeCtx();
    // Imported file (bar.ts) indexed first.
    const barMod = sym({
      name: "bar.ts",
      symbol_kind: "module",
      qualified: "bar.ts",
      source: "// bar",
    });
    const bar = sym({
      name: "Bar",
      symbol_kind: "class",
      qualified: "bar.ts:Bar",
      source: "class Bar {}",
    });
    repo.applyFileIndex(fileInput({ path: "bar.ts", symbols: [barMod, bar] }));

    // Importing module.
    const mod = sym({
      name: "auth.service.ts",
      symbol_kind: "module",
      qualified: PATH,
      source: "import",
    });
    repo.applyFileIndex(fileInput({ symbols: [mod] }));

    const dir = repo.repoSymbolDirectory(REPO);
    const modId = dir.find((d) => d.qualified === PATH)!.node_id;
    const barId = dir.find((d) => d.qualified === "bar.ts:Bar")!.node_id;

    const n = repo.rebuildResolvedEdges(
      REPO,
      PATH,
      "imports",
      [
        { src: modId, dst: barId },
        // an unresolved import contributes no edge (indexer would never emit a dst)
      ],
      "sess-1",
      "2026-01-05T00:00:00.000Z",
    );
    expect(n).toBe(1);
    const neigh = repo.findSymbolsByName("auth.service.ts", REPO, 5)[0]!.neighbors;
    expect(neigh.some((e) => e.edge === "imports" && e.id === barId)).toBe(true);
  });
});

describe("phase 3b — lookups", () => {
  it("findSymbolsByName / findSymbolsInFile / symbolDetail", () => {
    const { repo } = makeCtx();
    const mod = sym({
      name: "auth.service.ts",
      symbol_kind: "module",
      qualified: PATH,
      source: "// file",
    });
    const cls = sym({
      name: "AuthService",
      symbol_kind: "class",
      source: "class AuthService { }",
      start_line: 3,
      end_line: 9,
    });
    repo.applyFileIndex(fileInput({ symbols: [mod, cls] }));

    const byName = repo.findSymbolsByName("AuthService", REPO, 5);
    expect(byName).toHaveLength(1);
    expect(byName[0]!.facets).toMatchObject({
      symbol_kind: "class",
      name: "AuthService",
      path: PATH,
    });
    expect(byName[0]!.envelope.kind).toBe("mirror");

    const inFile = repo.findSymbolsInFile(REPO, PATH, 25);
    expect(inFile.map((s) => s.facets.name).sort()).toEqual(["AuthService", "auth.service.ts"]);

    const detail = repo.symbolDetail(byName[0]!.envelope.id)!;
    expect(detail.source).toContain("class AuthService");
  });
});
