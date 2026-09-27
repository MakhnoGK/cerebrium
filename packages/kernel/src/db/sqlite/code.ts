import { existsSync } from "node:fs";
import { injectable } from "tsyringe";
import type {
  ExtractedSymbol,
  FileIndexInput,
  FileIndexResult,
  RepoProvenance,
  SymbolDirEntry,
  SymbolFacets,
  SymbolLookup,
} from "@cerebrium/contracts/types";
import { toEnvelope } from "@cerebrium/contracts/types";
import { EdgeType } from "@cerebrium/contracts/vocab";
import type { CodeRepo } from "@/domain/ports/storage";
import { BaseRepo } from "@/db/sqlite/base";
import {
  edgesOf,
  enrichedById,
  ftsPut,
  insertEdge,
  insertRevision,
  syncChunks,
} from "@/db/sqlite/internal";
import { newId } from "@/core/ids";

// The code mirror: symbol nodes + their facet rows, per-file hash gate,
// incremental index application, cross-file edge resolution, structural lookups, and
// per-repo provenance. Symbol and edge writes reuse the shared primitives in internal.ts.
@injectable()
export class SqliteCodeRepo extends BaseRepo implements CodeRepo {
  async codeFileHash(repo: string, path: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT hash FROM code_files WHERE repo = ? AND path = ?")
      .get(repo, path) as { hash: string } | undefined;
    return row?.hash;
  }

  async listCodeFilePaths(repo: string): Promise<string[]> {
    return (
      this.db.prepare("SELECT path FROM code_files WHERE repo = ?").all(repo) as { path: string }[]
    ).map((r) => r.path);
  }

  private insertSymbolNode(
    repo: string,
    path: string,
    sym: ExtractedSymbol,
    lang: string,
    session_id: string,
    ts: string,
  ): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO nodes (id, memory_kind, type, title, project, origin, external_id, synced_at,
                            valid_from, created_by_session, created_at)
         VALUES (?, 'mirror', 'symbol', ?, ?, 'repo', ?, ?, ?, ?, ?)`,
      )
      .run(id, sym.qualified, repo, sym.external_id, ts, ts, session_id, ts);
    insertRevision(this.db, id, 1, sym.summary, session_id, null, ts);
    ftsPut(this.db, id, sym.qualified, sym.summary);
    syncChunks(this.db, id, 1, sym.summary, ts);
    this.db
      .prepare(
        `INSERT INTO symbols (node_id, repo, path, lang, symbol_kind, name, qualified, signature,
                              start_line, end_line, code_hash, source)
         VALUES (@node_id, @repo, @path, @lang, @symbol_kind, @name, @qualified, @signature,
                 @start_line, @end_line, @code_hash, @source)`,
      )
      .run({
        node_id: id,
        repo,
        path,
        lang,
        symbol_kind: sym.symbol_kind,
        name: sym.name,
        qualified: sym.qualified,
        signature: sym.signature,
        start_line: sym.start_line,
        end_line: sym.end_line,
        code_hash: sym.code_hash,
        source: sym.source,
      });
    return id;
  }

  private reviseSymbolNode(
    nodeId: string,
    sym: ExtractedSymbol,
    session_id: string,
    ts: string,
  ): void {
    const nextRev =
      (
        this.db.prepare("SELECT MAX(rev) AS m FROM revisions WHERE node_id = ?").get(nodeId) as {
          m: number;
        }
      ).m + 1;
    insertRevision(this.db, nodeId, nextRev, sym.summary, session_id, "re-index", ts);
    ftsPut(this.db, nodeId, sym.qualified, sym.summary);
    syncChunks(this.db, nodeId, nextRev, sym.summary, ts);
    // Revive a symbol that had disappeared and came back; refresh its sync stamp.
    this.db
      .prepare("UPDATE nodes SET invalidated_at = NULL, synced_at = ? WHERE id = ?")
      .run(ts, nodeId);
    this.db
      .prepare(
        `UPDATE symbols SET signature = ?, start_line = ?, end_line = ?, code_hash = ?, source = ? WHERE node_id = ?`,
      )
      .run(sym.signature, sym.start_line, sym.end_line, sym.code_hash, sym.source, nodeId);
  }

  // Pass 1 of indexing: diff a file's extracted symbols against the stored set and
  // apply the whole file's symbol/revision/FTS/defines/hash changes in ONE
  // transaction, so a crash mid-repo leaves a consistent partial index (the next
  // run resumes by hash-gate). Cross-file `imports`/`calls` edges are resolved in a
  // second pass once every file's symbols exist (see rebuildResolvedEdges).
  async applyFileIndex(input: FileIndexInput): Promise<FileIndexResult> {
    const result: FileIndexResult = { added: 0, updated: 0, invalidated: 0, edges: 0 };
    this.tx(() => {
      const prior = this.db
        .prepare(
          `SELECT s.node_id AS node_id, s.code_hash AS code_hash, n.external_id AS external_id,
                  n.invalidated_at AS invalidated_at
           FROM symbols s JOIN nodes n ON n.id = s.node_id WHERE s.repo = ? AND s.path = ?`,
        )
        .all(input.repo, input.path) as {
        node_id: string;
        code_hash: string;
        external_id: string;
        invalidated_at: string | null;
      }[];
      const priorByExt = new Map(prior.map((p) => [p.external_id, p]));

      const nodeByExt = new Map<string, string>();
      for (const sym of input.symbols) {
        const p = priorByExt.get(sym.external_id);
        if (!p) {
          nodeByExt.set(
            sym.external_id,
            this.insertSymbolNode(
              input.repo,
              input.path,
              sym,
              input.lang,
              input.session_id,
              input.ts,
            ),
          );
          result.added++;
        } else if (p.code_hash !== sym.code_hash || p.invalidated_at != null) {
          this.reviseSymbolNode(p.node_id, sym, input.session_id, input.ts);
          nodeByExt.set(sym.external_id, p.node_id);
          result.updated++;
        } else {
          nodeByExt.set(sym.external_id, p.node_id);
        }
      }

      const present = new Set(input.symbols.map((s) => s.external_id));
      for (const p of prior) {
        if (!present.has(p.external_id) && p.invalidated_at == null) {
          this.db
            .prepare("UPDATE nodes SET invalidated_at = ? WHERE id = ?")
            .run(input.ts, p.node_id);
          result.invalidated++;
        }
      }

      // Rebuild this file's `defines` edges (all endpoints local, resolvable now).
      this.invalidateFileEdges(input.repo, input.path, EdgeType.DEFINES, input.ts);
      for (const d of input.defines) {
        const src = nodeByExt.get(d.src);
        const dst = nodeByExt.get(d.dst);
        if (src && dst) {
          insertEdge(this.db, src, dst, EdgeType.DEFINES, "system", input.session_id, input.ts);
          result.edges++;
        }
      }

      this.db
        .prepare(
          `INSERT INTO code_files (repo, path, lang, hash, indexed_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo, path) DO UPDATE SET lang = excluded.lang, hash = excluded.hash, indexed_at = excluded.indexed_at`,
        )
        .run(input.repo, input.path, input.lang, input.fileHash, input.ts);
    });
    return result;
  }

  // All (repo, path) symbol node ids, regardless of validity — the anchor set for
  // recreating a file's outgoing system edges.
  private fileSymbolNodeIds(repo: string, path: string): string[] {
    return (
      this.db
        .prepare("SELECT node_id FROM symbols WHERE repo = ? AND path = ?")
        .all(repo, path) as {
        node_id: string;
      }[]
    ).map((r) => r.node_id);
  }

  private invalidateFileEdges(repo: string, path: string, type: EdgeType, ts: string): void {
    const ids = this.fileSymbolNodeIds(repo, path);
    if (!ids.length) return;
    const ph = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE edges SET invalidated_at = ? WHERE type = ? AND invalidated_at IS NULL AND src IN (${ph})`,
      )
      .run(ts, type, ...ids);
  }

  // Live (non-invalidated) symbols for a repo — the directory used to resolve
  // cross-file imports/calls once every file's symbols exist.
  async repoSymbolDirectory(repo: string): Promise<SymbolDirEntry[]> {
    return this.db
      .prepare(
        `SELECT s.node_id AS node_id, s.path AS path, s.name AS name, s.qualified AS qualified,
                s.symbol_kind AS symbol_kind
         FROM symbols s JOIN nodes n ON n.id = s.node_id
         WHERE s.repo = ? AND n.invalidated_at IS NULL`,
      )
      .all(repo) as SymbolDirEntry[];
  }

  // Pass 2 of indexing: replace a file's `imports`/`calls` edges with a freshly
  // resolved set. Only called for files (re)indexed this run — incremental.
  async rebuildResolvedEdges(
    repo: string,
    path: string,
    type: EdgeType,
    pairs: { src: string; dst: string }[],
    session_id: string,
    ts: string,
  ): Promise<number> {
    let n = 0;
    this.tx(() => {
      this.invalidateFileEdges(repo, path, type, ts);
      const seen = new Set<string>();
      for (const p of pairs) {
        const key = `${p.src} ${p.dst}`;
        if (p.src === p.dst || seen.has(key)) continue;
        seen.add(key);
        insertEdge(this.db, p.src, p.dst, type, "system", session_id, ts);
        n++;
      }
    });
    return n;
  }

  // Whole-repo sweep: a file gone from disk -> invalidate its symbol nodes (never
  // deleted; history + documents edges survive) and drop the code_files bookkeeping.
  async removeFile(repo: string, path: string, ts: string): Promise<number> {
    let invalidated = 0;
    this.tx(() => {
      const ids = this.fileSymbolNodeIds(repo, path);
      const inval = this.db.prepare(
        "UPDATE nodes SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL",
      );
      for (const id of ids) invalidated += inval.run(ts, id).changes;
      this.db.prepare("DELETE FROM code_files WHERE repo = ? AND path = ?").run(repo, path);
    });
    return invalidated;
  }

  async symbolDetail(nodeId: string): Promise<(SymbolFacets & { source: string }) | undefined> {
    return this.symbolDetailNow(nodeId);
  }

  private symbolDetailNow(nodeId: string): (SymbolFacets & { source: string }) | undefined {
    return this.db
      .prepare(
        `SELECT repo, path, lang, symbol_kind, name, qualified, signature, start_line, end_line, source
         FROM symbols WHERE node_id = ?`,
      )
      .get(nodeId) as (SymbolFacets & { source: string }) | undefined;
  }

  private symbolLookup(nodeId: string): SymbolLookup | undefined {
    const row = enrichedById(this.db, nodeId);
    const detail = this.symbolDetailNow(nodeId);
    if (!row || !detail) return undefined;
    const { source: _source, ...facets } = detail;
    const structural = new Set([EdgeType.DEFINES, "calls", "imports"]);
    const neighbors = edgesOf(this.db, nodeId).filter((e) => structural.has(e.edge));
    return { envelope: toEnvelope(row), facets, neighbors };
  }

  async findSymbolsByName(
    name: string,
    repo: string | undefined,
    limit: number,
  ): Promise<SymbolLookup[]> {
    const params: unknown[] = [name, name];
    let clause = "(s.name = ? OR s.qualified = ?)";
    if (repo !== undefined) {
      clause += " AND s.repo = ?";
      params.push(repo);
    }
    const ids = (
      this.db
        .prepare(
          `SELECT s.node_id AS node_id FROM symbols s JOIN nodes n ON n.id = s.node_id
           WHERE ${clause} AND n.invalidated_at IS NULL
           ORDER BY s.qualified LIMIT ?`,
        )
        .all(...params, limit) as { node_id: string }[]
    ).map((r) => r.node_id);
    return ids.map((id) => this.symbolLookup(id)).filter((x): x is SymbolLookup => x !== undefined);
  }

  async findSymbolsInFile(
    repo: string | undefined,
    path: string,
    limit: number,
  ): Promise<SymbolLookup[]> {
    const params: unknown[] = [path, `%/${path}`];
    // Match an exact repo-relative path, or a path suffix so callers can pass a bare
    // file name / partial path without knowing the repo root layout.
    let clause = "(s.path = ? OR s.path LIKE ?)";
    if (repo !== undefined) {
      clause += " AND s.repo = ?";
      params.push(repo);
    }
    const ids = (
      this.db
        .prepare(
          `SELECT s.node_id AS node_id FROM symbols s JOIN nodes n ON n.id = s.node_id
           WHERE ${clause} AND n.invalidated_at IS NULL
           ORDER BY s.start_line LIMIT ?`,
        )
        .all(...params, limit) as { node_id: string }[]
    ).map((r) => r.node_id);
    return ids.map((id) => this.symbolLookup(id)).filter((x): x is SymbolLookup => x !== undefined);
  }

  // Record which root/branch/commit an index run reflected. Rewritten every run so
  // it stays accurate despite the per-file hash-gate. `root` lets a later run resolve
  // the repo by name without MEMORY_CODE_ROOTS. Informational for branch/commit/dirty.
  async setRepoProvenance(
    repo: string,
    root: string | null,
    branch: string | null,
    commit: string | null,
    dirty: boolean,
    ts: string,
  ): Promise<void> {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO code_repos (repo, root, branch, commit_sha, dirty, indexed_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo) DO UPDATE SET root = excluded.root, branch = excluded.branch,
             commit_sha = excluded.commit_sha, dirty = excluded.dirty, indexed_at = excluded.indexed_at`,
        )
        .run(repo, root, branch, commit, dirty ? 1 : 0, ts);
    });
  }

  async repoProvenance(repo: string): Promise<RepoProvenance | undefined> {
    return this.provenanceRows().find((r) => r.repo === repo);
  }

  // Repos remembered from a prior index-by-path, as index targets. Lets code_index
  // resolve a repo by name when MEMORY_CODE_ROOTS doesn't define it.
  async storedRepoRoots(): Promise<{ name: string; root: string }[]> {
    return this.provenanceRows()
      .filter((r): r is RepoProvenance & { root: string } => !!r.root)
      .map((r) => ({ name: r.repo, root: r.root }));
  }

  async allRepoProvenance(): Promise<RepoProvenance[]> {
    return this.provenanceRows();
  }

  private provenanceRows(): RepoProvenance[] {
    // Read-only inspection (stats CLI) may hit a DB that a new-build writer hasn't
    // migrated yet — tolerate the table, or the `root` column, being absent.
    if (
      !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_repos'").get()
    )
      return [];
    const hasRoot = (
      this.db.prepare("PRAGMA table_info(code_repos)").all() as { name: string }[]
    ).some((c) => c.name === "root");
    const rootCol = hasRoot ? "root" : "NULL AS root";
    return (
      this.db
        .prepare(
          `SELECT repo, ${rootCol}, branch, commit_sha, dirty, indexed_at FROM code_repos ORDER BY repo`,
        )
        .all() as {
        repo: string;
        root: string | null;
        branch: string | null;
        commit_sha: string | null;
        dirty: number;
        indexed_at: string;
      }[]
    ).map((r) => ({
      repo: r.repo,
      root: r.root,
      branch: r.branch,
      commit: r.commit_sha,
      dirty: !!r.dirty,
      indexed_at: r.indexed_at,
      // A stored root is a filesystem claim, and the only way to check it is to look.
      detached: r.root !== null && !existsSync(r.root),
    }));
  }
}
