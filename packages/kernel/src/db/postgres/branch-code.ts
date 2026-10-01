import { injectable } from "tsyringe";
import { codeSymbolId, sha256Hex, type CodeRepoDescriptor } from "@cerebrium/contracts/code";
import type {
  BranchCodeRepo,
  BranchFileChange,
  BranchScope,
  CitableCodeSymbol,
  CodeBranchRow,
  CodeRefRow,
  CodeRepoRow,
  CodeSymbolDetail,
  CodeSymbolRow,
  CodeUnitSource,
  ResolvedCodeRef,
  UnitParse,
  UnitRefs,
} from "@/domain/ports/storage";
import { PgBaseRepo } from "@/db/postgres/base";
import type { Params } from "@/db/postgres/database";
import { ACTIVE_SPACE, toVectorLiteral } from "@/db/postgres/internal";
import type { TextQuery } from "@/core/fts";
import { newId } from "@/core/ids";

const VEC_K = 1000;
const TEXT_HITS = 5000;

const SYMBOL_COLUMNS = `
  s.id, s.unit_id, s.kind, s.name, s.qualified, s.signature, s.summary, s.start_line,
  s.end_line, f.path, u.lang, u.parsed_at, r.id AS repo_id, r.remote_key, r.display_name,
  f.branch`;

const SYMBOL_JOINS = `
  JOIN code_units u ON u.id = f.unit_id
  JOIN code_symbols s ON s.unit_id = u.id
  JOIN code_repos r ON r.id = f.repo_id`;

@injectable()
export class PgBranchCodeRepo extends PgBaseRepo implements BranchCodeRepo {
  async upsertRepo(
    desc: CodeRepoDescriptor & { display_name: string },
    ts: string,
  ): Promise<CodeRepoRow> {
    return this.tx(async () => {
      await this.db.query(
        `INSERT INTO code_repos (id, remote_key, display_name, default_branch, created_at, updated_at)
         VALUES (@id, @remote_key, @display_name, @default_branch, @ts, @ts)
         ON CONFLICT (remote_key) DO UPDATE SET
           display_name = excluded.display_name,
           default_branch = COALESCE(excluded.default_branch, code_repos.default_branch),
           updated_at = excluded.updated_at`,
        {
          id: newId(),
          remote_key: desc.remote_key,
          display_name: desc.display_name,
          default_branch: desc.default_branch ?? null,
          ts,
        },
      );

      return (await this.repoByKey(desc.remote_key))!;
    });
  }

  async repoByKey(remoteKey: string): Promise<CodeRepoRow | undefined> {
    return this.one<CodeRepoRow>(
      "SELECT id, remote_key, display_name, default_branch FROM code_repos WHERE remote_key = @remoteKey",
      { remoteKey },
    );
  }

  async reposNamed(name: string): Promise<CodeRepoRow[]> {
    return this.all<CodeRepoRow>(
      `SELECT id, remote_key, display_name, default_branch FROM code_repos
       WHERE remote_key = lower(@name) OR display_name = @name ORDER BY remote_key`,
      { name },
    );
  }

  async allRepos(): Promise<CodeRepoRow[]> {
    return this.all<CodeRepoRow>(
      "SELECT id, remote_key, display_name, default_branch FROM code_repos ORDER BY remote_key",
    );
  }

  async branch(repoId: string, branch: string): Promise<CodeBranchRow | undefined> {
    const row = await this.one<Omit<CodeBranchRow, "dirty"> & { dirty: number }>(
      `SELECT branch, commit_sha, dirty, indexed_at, retired_at FROM code_branches
       WHERE repo_id = @repoId AND branch = @branch`,
      { repoId, branch },
    );

    return row && { ...row, dirty: row.dirty === 1 };
  }

  async missingBlobs(hashes: string[]): Promise<string[]> {
    if (!hashes.length) return [];

    return (
      await this.all<{ hash: string }>(
        `SELECT DISTINCT h AS hash FROM unnest(@hashes::text[]) AS h
         WHERE NOT EXISTS (SELECT 1 FROM code_blobs b WHERE b.hash = h)
         ORDER BY hash`,
        { hashes },
      )
    ).map((r) => r.hash);
  }

  async storeBlobs(blobs: { hash: string; content: Buffer }[], ts: string): Promise<number> {
    if (!blobs.length) return 0;

    return this.run(
      `INSERT INTO code_blobs (hash, bytes, content, created_at)
       SELECT h, b, decode(c, 'hex'), @ts
       FROM unnest(@hashes::text[], @bytes::int[], @contents::text[]) AS x(h, b, c)
       ON CONFLICT (hash) DO NOTHING`,
      {
        hashes: blobs.map((b) => b.hash),
        bytes: blobs.map((b) => b.content.length),
        contents: blobs.map((b) => b.content.toString("hex")),
        ts,
      },
    );
  }

  async ensureUnits(
    units: { id: string; blob_hash: string; path: string; lang: string }[],
    ts: string,
  ): Promise<void> {
    if (!units.length) return;

    await this.run(
      `INSERT INTO code_units (id, blob_hash, path, lang, created_at)
       SELECT i, h, p, l, @ts
       FROM unnest(@ids::text[], @hashes::text[], @paths::text[], @langs::text[]) AS x(i, h, p, l)
       ON CONFLICT (id) DO NOTHING`,
      {
        ids: units.map((u) => u.id),
        hashes: units.map((u) => u.blob_hash),
        paths: units.map((u) => u.path),
        langs: units.map((u) => u.lang),
        ts,
      },
    );
  }

  // A NUL becomes U+FFFD: one UTF-16 unit for another, so lines and offsets hold, and the
  // symbol sources cut from it fit a text column.
  async unparsedUnits(ids: string[], limit: number): Promise<CodeUnitSource[]> {
    if (!ids.length) return [];

    const rows = await this.all<Omit<CodeUnitSource, "content"> & { content: Buffer }>(
      `SELECT u.id, u.path, u.lang, b.content FROM code_units u
       JOIN code_blobs b ON b.hash = u.blob_hash
       WHERE u.id = ANY(@ids) AND u.parsed_at IS NULL
       ORDER BY u.id LIMIT @limit`,
      { ids, limit },
    );

    return rows.map((r) => ({
      ...r,
      content: r.content.toString("utf8").replaceAll("\0", "\uFFFD"),
    }));
  }

  async storeParse(unitId: string, parse: UnitParse, ts: string): Promise<number> {
    return this.tx(async () => {
      const unit = await this.one<{ parsed_at: string | null }>(
        "SELECT parsed_at FROM code_units WHERE id = @unitId FOR UPDATE",
        { unitId },
      );

      if (!unit) throw new Error(`code unit ${unitId} does not exist`);

      if (unit.parsed_at !== null) return 0;

      const idByExt = new Map<string, string>();
      const rows = parse.symbols.map((sym) => {
        const id = codeSymbolId(unitId, sym.qualified, sym.symbol_kind);

        if (!idByExt.has(sym.external_id)) idByExt.set(sym.external_id, id);

        return { id, sym };
      });

      const inserted = rows.length
        ? ((
            await this.db.query(
              `INSERT INTO code_symbols (id, unit_id, kind, name, qualified, signature, summary,
                                         start_line, end_line, code_hash, source, embed_hash)
               SELECT id, @unitId, kind, name, qualified, signature, summary, sl, el, ch, src, eh
               FROM unnest(@ids::text[], @kinds::text[], @names::text[], @qualified::text[],
                           @signatures::text[], @summaries::text[], @starts::int[], @ends::int[],
                           @codeHashes::text[], @sources::text[], @embedHashes::text[])
                 AS x(id, kind, name, qualified, signature, summary, sl, el, ch, src, eh)
               ON CONFLICT (id) DO NOTHING`,
              {
                unitId,
                ids: rows.map((r) => r.id),
                kinds: rows.map((r) => r.sym.symbol_kind),
                names: rows.map((r) => r.sym.name),
                qualified: rows.map((r) => r.sym.qualified),
                signatures: rows.map((r) => r.sym.signature),
                summaries: rows.map((r) => r.sym.summary),
                starts: rows.map((r) => r.sym.start_line),
                ends: rows.map((r) => r.sym.end_line),
                codeHashes: rows.map((r) => r.sym.code_hash),
                sources: rows.map((r) => r.sym.source),
                embedHashes: rows.map((r) => sha256Hex(r.sym.summary)),
              },
            )
          ).rowCount ?? 0)
        : 0;

      const defines = parse.defines
        .map((d) => ({ src: idByExt.get(d.src), dst: idByExt.get(d.dst) }))
        .filter((d): d is { src: string; dst: string } => !!d.src && !!d.dst && d.src !== d.dst);

      if (defines.length) {
        await this.db.query(
          `INSERT INTO code_defines (unit_id, src_symbol, dst_symbol)
           SELECT @unitId, s, d FROM unnest(@srcs::text[], @dsts::text[]) AS x(s, d)
           ON CONFLICT DO NOTHING`,
          { unitId, srcs: defines.map((d) => d.src), dsts: defines.map((d) => d.dst) },
        );
      }

      if (parse.imports.length) {
        await this.db.query(
          `INSERT INTO code_imports (unit_id, seq, name, candidate_paths, namespace, by_name)
           SELECT @unitId, seq, name, ARRAY(SELECT jsonb_array_elements_text(cp)), ns, bn
           FROM unnest(@seqs::int[], @names::text[], @paths::jsonb[], @namespaces::boolean[],
                       @byNames::boolean[]) AS x(seq, name, cp, ns, bn)`,
          {
            unitId,
            seqs: parse.imports.map((_, i) => i),
            names: parse.imports.map((i) => i.name),
            paths: parse.imports.map((i) => JSON.stringify(i.candidatePaths)),
            namespaces: parse.imports.map((i) => i.namespace),
            byNames: parse.imports.map((i) => i.byName ?? false),
          },
        );
      }

      if (parse.calls.length) {
        await this.db.query(
          `INSERT INTO code_calls (unit_id, seq, src_qualified, callee)
           SELECT @unitId, seq, sq, callee
           FROM unnest(@seqs::int[], @srcs::text[], @callees::text[]) AS x(seq, sq, callee)`,
          {
            unitId,
            seqs: parse.calls.map((_, i) => i),
            srcs: parse.calls.map((c) => c.srcQualified),
            callees: parse.calls.map((c) => c.callee),
          },
        );
      }

      await this.db.query(
        "UPDATE code_units SET parsed_at = @ts, parse_error = NULL WHERE id = @unitId",
        { ts, unitId },
      );

      return inserted;
    });
  }

  async recordParseFailure(unitId: string, error: string, ts: string): Promise<void> {
    await this.run(
      `UPDATE code_units SET parsed_at = @ts, parse_error = @error
       WHERE id = @unitId AND parsed_at IS NULL`,
      { ts, error: error.slice(0, 500), unitId },
    );
  }

  async commitBranch(input: {
    repoId: string;
    branch: string;
    commit: string | null;
    dirty: boolean;
    files: { path: string; unit_id: string }[];
    ts: string;
  }): Promise<BranchFileChange> {
    const { repoId, branch, ts } = input;

    return this.tx(async () => {
      await this.db.query(
        `INSERT INTO code_branches (repo_id, branch, commit_sha, dirty, indexed_at, last_seen_at)
         VALUES (@repoId, @branch, @commit, @dirty, @ts, @ts)
         ON CONFLICT (repo_id, branch) DO UPDATE SET
           commit_sha = excluded.commit_sha, dirty = excluded.dirty,
           indexed_at = excluded.indexed_at, last_seen_at = excluded.last_seen_at, retired_at = NULL`,
        { repoId, branch, commit: input.commit, dirty: input.dirty ? 1 : 0, ts },
      );

      const live = new Map(
        (
          await this.all<{ path: string; unit_id: string }>(
            `SELECT path, unit_id FROM code_branch_files
             WHERE repo_id = @repoId AND branch = @branch AND invalidated_at IS NULL`,
            { repoId, branch },
          )
        ).map((r) => [r.path, r.unit_id]),
      );
      const wanted = new Map(input.files.map((f) => [f.path, f.unit_id]));
      const added = [...wanted].filter(([path, unit]) => live.get(path) !== unit);
      const removed = [...live.keys()].filter((path) => !wanted.has(path));
      const retire = [...added.map(([path]) => path).filter((p) => live.has(p)), ...removed];

      if (retire.length) {
        await this.db.query(
          `UPDATE code_branch_files SET invalidated_at = @ts
           WHERE repo_id = @repoId AND branch = @branch AND invalidated_at IS NULL
             AND path = ANY(@paths)`,
          { ts, repoId, branch, paths: retire },
        );
      }

      if (added.length) {
        await this.db.query(
          `INSERT INTO code_branch_files (repo_id, branch, path, unit_id, valid_from)
           SELECT @repoId, @branch, p, u, @ts FROM unnest(@paths::text[], @units::text[]) AS x(p, u)`,
          {
            repoId,
            branch,
            ts,
            paths: added.map(([p]) => p),
            units: added.map(([, u]) => u),
          },
        );
      }

      return { changed: added.length, removed: removed.length };
    });
  }

  async seeBranches(repoId: string, branches: string[], ts: string): Promise<void> {
    if (!branches.length) return;

    await this.run(
      `UPDATE code_branches SET last_seen_at = @ts
       WHERE repo_id = @repoId AND branch = ANY(@branches) AND last_seen_at < @ts`,
      { ts, repoId, branches },
    );
  }

  async retireUnseen(
    repoId: string,
    keep: string[],
    seenBefore: string,
    ts: string,
  ): Promise<string[]> {
    return (
      await this.tx(() =>
        this.all<{ branch: string }>(
          `UPDATE code_branches SET retired_at = @ts
           WHERE repo_id = @repoId AND retired_at IS NULL AND last_seen_at < @seenBefore
             AND NOT (branch = ANY(@keep))
           RETURNING branch`,
          { ts, repoId, seenBefore, keep },
        ),
      )
    )
      .map((r) => r.branch)
      .sort();
  }

  async symbolsByName(
    scopes: BranchScope[],
    name: string,
    limit: number,
  ): Promise<CodeSymbolRow[]> {
    return this.scopedSymbols(
      scopes,
      "(s.name = @name OR s.qualified = @name)",
      { name },
      {
        order: "qualified, id",
        limit,
      },
    );
  }

  async symbolsInFile(
    scopes: BranchScope[],
    path: string,
    limit: number,
  ): Promise<CodeSymbolRow[]> {
    return this.scopedSymbols(
      scopes,
      "(f.path = @path OR right(f.path, length(@path) + 1) = '/' || @path)",
      { path },
      { order: "path, start_line, id", limit },
    );
  }

  async symbolsByIds(scopes: BranchScope[], ids: string[]): Promise<CodeSymbolRow[]> {
    if (!ids.length) return [];

    return this.scopedSymbols(
      scopes,
      "s.id = ANY(@ids)",
      { ids },
      { order: "id", limit: ids.length },
    );
  }

  async symbolDetail(id: string): Promise<CodeSymbolDetail | undefined> {
    return this.one<CodeSymbolDetail>(
      `SELECT s.id, s.unit_id, s.kind, s.name, s.qualified, s.signature, s.summary, s.start_line,
              s.end_line, u.path, u.lang, u.parsed_at, s.source
       FROM code_symbols s JOIN code_units u ON u.id = s.unit_id WHERE s.id = @id`,
      { id },
    );
  }

  async branchesHolding(
    unitId: string,
  ): Promise<{ remote_key: string; display_name: string; branch: string }[]> {
    return this.all(
      `SELECT r.remote_key, r.display_name, f.branch
       FROM code_branch_files f
       JOIN code_repos r ON r.id = f.repo_id
       JOIN code_branches b ON b.repo_id = f.repo_id AND b.branch = f.branch
       WHERE f.unit_id = @unitId AND f.invalidated_at IS NULL AND b.retired_at IS NULL
       ORDER BY r.remote_key, f.branch`,
      { unitId },
    );
  }

  async directory(
    scope: BranchScope,
  ): Promise<{ id: string; path: string; name: string; qualified: string; kind: string }[]> {
    const params: Params = {};

    return this.all(
      `WITH ${this.files([scope], params)}
       SELECT s.id, f.path, s.name, s.qualified, s.kind
       FROM files f JOIN code_symbols s ON s.unit_id = f.unit_id
       ORDER BY f.path, s.start_line, s.id`,
      params,
    );
  }

  async unitRefs(unitIds: string[]): Promise<Map<string, UnitRefs>> {
    const out = new Map<string, UnitRefs>(unitIds.map((id) => [id, { imports: [], calls: [] }]));

    if (!unitIds.length) return out;

    for (const r of await this.all<{
      unit_id: string;
      name: string;
      candidate_paths: string[];
      namespace: boolean;
      by_name: boolean;
    }>(
      `SELECT unit_id, name, candidate_paths, namespace, by_name FROM code_imports
       WHERE unit_id = ANY(@unitIds) ORDER BY unit_id, seq`,
      { unitIds },
    )) {
      out.get(r.unit_id)?.imports.push({
        name: r.name,
        candidatePaths: r.candidate_paths,
        namespace: r.namespace,
        ...(r.by_name ? { byName: true } : {}),
      });
    }

    for (const r of await this.all<{ unit_id: string; src_qualified: string; callee: string }>(
      `SELECT unit_id, src_qualified, callee FROM code_calls
       WHERE unit_id = ANY(@unitIds) ORDER BY unit_id, seq`,
      { unitIds },
    )) {
      out.get(r.unit_id)?.calls.push({ srcQualified: r.src_qualified, callee: r.callee });
    }

    return out;
  }

  async callersOf(
    scope: BranchScope,
    name: string,
  ): Promise<{ unit_id: string; path: string; lang: string }[]> {
    const params: Params = { name };

    return this.all(
      `WITH ${this.files([scope], params)}
       SELECT DISTINCT f.unit_id, f.path, u.lang
       FROM files f
       JOIN code_calls c ON c.unit_id = f.unit_id
       JOIN code_units u ON u.id = f.unit_id
       WHERE c.callee = @name
       ORDER BY f.path`,
      params,
    );
  }

  async importersOf(
    scope: BranchScope,
    name: string,
    path: string,
  ): Promise<{ unit_id: string; path: string; lang: string }[]> {
    const params: Params = { name, path };

    return this.all(
      `WITH ${this.files([scope], params)}
       SELECT DISTINCT f.unit_id, f.path, u.lang
       FROM files f
       JOIN code_imports i ON i.unit_id = f.unit_id
       JOIN code_units u ON u.id = f.unit_id
       WHERE i.name = @name OR @path = ANY(i.candidate_paths)
       ORDER BY f.path`,
      params,
    );
  }

  async definesOf(symbolId: string): Promise<{ src: string; dst: string }[]> {
    return this.all(
      `SELECT src_symbol AS src, dst_symbol AS dst FROM code_defines
       WHERE src_symbol = @symbolId OR dst_symbol = @symbolId ORDER BY src_symbol, dst_symbol`,
      { symbolId },
    );
  }

  async unitOfPath(
    scope: BranchScope,
    path: string,
  ): Promise<{ unit_id: string; lang: string } | undefined> {
    const params: Params = { path };

    return this.one(
      `WITH ${this.files([scope], params)}
       SELECT f.unit_id, u.lang FROM files f JOIN code_units u ON u.id = f.unit_id
       WHERE f.path = @path`,
      params,
    );
  }

  async textSearch(
    scopes: BranchScope[],
    text: TextQuery,
    cap: number,
  ): Promise<(CodeSymbolRow & { text_rank: number })[]> {
    if (!scopes.length) return [];

    const params: Params = { cap };
    const match = text
      .flatMap((words, i) => {
        const name = `t${String(i)}`;
        const op = words.length > 1 ? "###" : "|||";

        params[name] = words.join(" ");

        return [`cs.qualified ${op} @${name}`, `cs.summary ${op} @${name}`];
      })
      .join(" OR ");

    // Scored on its own: joined to the branch files in one statement, pg_search's JoinScan
    // fails to plan it on a real-sized index.
    const hits = await this.all<{ id: string; score: number }>(
      `SELECT cs.id, pdb.score(cs.id) AS score FROM code_symbols cs
       WHERE ${match}
       ORDER BY score DESC, cs.id
       LIMIT @hitCap`,
      { ...params, hitCap: TEXT_HITS },
    );

    if (!hits.length) return [];

    const score = new Map(hits.map((h) => [h.id, h.score]));
    const rows = await this.symbolsByIds(
      scopes,
      hits.map((h) => h.id),
    );

    return rows
      .map((r) => ({ ...r, text_rank: -(score.get(r.id) ?? 0) }))
      .sort((a, b) => a.text_rank - b.text_rank || a.id.localeCompare(b.id))
      .slice(0, cap);
  }

  async vectorSearch(
    scopes: BranchScope[],
    embedding: number[],
    cap: number,
  ): Promise<(CodeSymbolRow & { distance: number })[]> {
    if (!scopes.length) return [];

    const params: Params = { q: toVectorLiteral(embedding), k: VEC_K, cap };

    return this.all(
      `WITH ${this.files(scopes, params)},
       wanted AS (
         SELECT DISTINCT s.embed_hash FROM files f JOIN code_symbols s ON s.unit_id = f.unit_id
       ),
       knn AS (
         SELECT v.embed_hash, v.embedding <=> @q::vector AS distance
         FROM code_vectors v JOIN wanted w ON w.embed_hash = v.embed_hash
         WHERE v.space_id = ${ACTIVE_SPACE}
         ORDER BY distance, v.embed_hash
         LIMIT @k
       )
       SELECT * FROM (
         SELECT DISTINCT ON (s.id) ${SYMBOL_COLUMNS}, knn.distance
         FROM files f ${SYMBOL_JOINS}
         JOIN knn ON knn.embed_hash = s.embed_hash
         ORDER BY s.id, f.branch
       ) x
       ORDER BY distance, id
       LIMIT @cap`,
      params,
    );
  }

  async insertRef(ref: CodeRefRow, ts: string): Promise<void> {
    await this.run(
      `INSERT INTO code_refs (src, type, repo, remote_key, path, qualified, symbol_kind,
                             symbol_live, valid_from)
       VALUES (@src, @type, @repo, @remote_key, @path, @qualified, @symbol_kind, 1, @ts)
       ON CONFLICT (src, type, repo, path, qualified) DO UPDATE SET
         remote_key = excluded.remote_key, symbol_kind = excluded.symbol_kind,
         symbol_live = 1, invalidated_at = NULL`,
      { ...ref, ts },
    );
  }

  async hasRef(src: string, remoteKey: string, path: string, qualified: string): Promise<boolean> {
    return (
      (await this.one(
        `SELECT 1 FROM code_refs
         WHERE src = @src AND remote_key = @remoteKey AND path = @path AND qualified = @qualified
           AND invalidated_at IS NULL
         LIMIT 1`,
        { src, remoteKey, path, qualified },
      )) !== undefined
    );
  }

  async citableSymbols(): Promise<CitableCodeSymbol[]> {
    return this.all(
      `SELECT DISTINCT ON (r.remote_key, u.path, s.qualified)
              s.id, s.name, s.kind, s.qualified, u.path, r.remote_key, r.display_name AS repo
       FROM code_branch_files f
       JOIN code_branches b ON b.repo_id = f.repo_id AND b.branch = f.branch
       JOIN code_repos r ON r.id = f.repo_id
       JOIN code_units u ON u.id = f.unit_id
       JOIN code_symbols s ON s.unit_id = u.id
       WHERE f.invalidated_at IS NULL AND b.retired_at IS NULL
       ORDER BY r.remote_key, u.path, s.qualified,
                (f.branch = r.default_branch) DESC, b.indexed_at DESC`,
    );
  }

  async indexWatermark(): Promise<string | null> {
    const row = await this.one<{ files: number; gone: number }>(
      "SELECT COUNT(*)::int AS files, COUNT(invalidated_at)::int AS gone FROM code_branch_files",
    );

    return row ? `${String(row.files)}:${String(row.gone)}` : null;
  }

  async resolveRefs(srcIds: string[], scopes: BranchScope[]): Promise<ResolvedCodeRef[]> {
    if (!srcIds.length || !scopes.length) return [];

    const params: Params = { srcIds };
    const rows = await this.all<CodeSymbolRow & { ref_src: string; ref_type: string }>(
      `WITH ${this.files(scopes, params)}
       SELECT DISTINCT ON (cr.src, cr.type, cr.path, cr.qualified)
              cr.src AS ref_src, cr.type AS ref_type, ${SYMBOL_COLUMNS}
       FROM code_refs cr
       JOIN code_repos r ON r.remote_key = cr.remote_key
       JOIN files f ON f.repo_id = r.id AND f.path = cr.path
       JOIN code_units u ON u.id = f.unit_id
       JOIN code_symbols s ON s.unit_id = u.id AND s.qualified = cr.qualified
       WHERE cr.src = ANY(@srcIds) AND cr.invalidated_at IS NULL
       ORDER BY cr.src, cr.type, cr.path, cr.qualified, (s.kind = cr.symbol_kind) DESC, f.branch`,
      params,
    );

    return rows.map(({ ref_src, ref_type, ...symbol }) => ({
      src: ref_src,
      type: ref_type,
      symbol,
    }));
  }

  async pendingEmbeddings(limit: number): Promise<{ embed_hash: string; text: string }[]> {
    return this.all(
      `SELECT DISTINCT ON (s.embed_hash) s.embed_hash, s.summary AS text
       FROM code_symbols s
       WHERE NOT EXISTS (
               SELECT 1 FROM code_vectors v
               WHERE v.space_id = ${ACTIVE_SPACE} AND v.embed_hash = s.embed_hash)
         AND EXISTS (
               SELECT 1 FROM code_branch_files f
               WHERE f.unit_id = s.unit_id AND f.invalidated_at IS NULL)
       ORDER BY s.embed_hash
       LIMIT @limit`,
      { limit },
    );
  }

  async commitVectors(
    items: { embed_hash: string; vector: number[] }[],
    model: string,
    version: string,
    ts: string,
  ): Promise<void> {
    if (!items.length) return;

    await this.tx(async () => {
      const space = await this.one<{ id: number; model: string; dim: number }>(
        "SELECT id, model, dim FROM vector_spaces WHERE active",
      );

      if (!space) throw new Error("the Postgres store has no active vector space");

      if (space.model !== model) {
        throw new Error(
          `embedding model '${model}' does not match the active vector space (${space.model})`,
        );
      }

      for (const it of items) {
        if (it.vector.length !== space.dim) {
          throw new Error(
            `a ${String(it.vector.length)}-d vector does not fit the active ${String(space.dim)}-d space`,
          );
        }
      }

      await this.db.query(
        `INSERT INTO code_vectors (space_id, embed_hash, embedding, model_version, ts)
         SELECT @space, h, e::vector, @version, @ts FROM unnest(@hashes::text[], @vectors::text[]) AS x(h, e)
         ON CONFLICT (space_id, embed_hash) DO NOTHING`,
        {
          space: space.id,
          hashes: items.map((i) => i.embed_hash),
          vectors: items.map((i) => toVectorLiteral(i.vector)),
          version,
          ts,
        },
      );
    });
  }

  async embeddingBacklog(): Promise<number> {
    return (
      (
        await this.one<{ c: number }>(
          `SELECT COUNT(DISTINCT s.embed_hash) AS c FROM code_symbols s
           WHERE NOT EXISTS (
                   SELECT 1 FROM code_vectors v
                   WHERE v.space_id = ${ACTIVE_SPACE} AND v.embed_hash = s.embed_hash)
             AND EXISTS (
                   SELECT 1 FROM code_branch_files f
                   WHERE f.unit_id = s.unit_id AND f.invalidated_at IS NULL)`,
        )
      )?.c ?? 0
    );
  }

  // The live (or, under asOf, then-live) files of the scoped branches, as a CTE named `files`.
  private files(scopes: BranchScope[], params: Params): string {
    params.scopeRepos = scopes.map((s) => s.repo.id);
    params.scopeBranches = scopes.map((s) => s.branch);

    const asOf = scopes.find((s) => s.asOf !== undefined)?.asOf;
    let live = "f.invalidated_at IS NULL";

    if (asOf !== undefined) {
      params.scopeAsOf = asOf;
      live =
        "f.valid_from <= @scopeAsOf AND (f.invalidated_at IS NULL OR f.invalidated_at > @scopeAsOf)";
    }

    return `files AS (
       SELECT f.repo_id, f.branch, f.path, f.unit_id
       FROM code_branch_files f
       JOIN unnest(@scopeRepos::text[], @scopeBranches::text[]) AS sc(repo_id, branch)
         ON sc.repo_id = f.repo_id AND sc.branch = f.branch
       WHERE ${live}
     )`;
  }

  private async scopedSymbols(
    scopes: BranchScope[],
    where: string,
    extra: Params,
    opts: { order: string; limit: number },
  ): Promise<CodeSymbolRow[]> {
    if (!scopes.length) return [];

    const params: Params = { ...extra, limit: opts.limit };

    return this.all<CodeSymbolRow>(
      `WITH ${this.files(scopes, params)}
       SELECT * FROM (
         SELECT DISTINCT ON (s.id) ${SYMBOL_COLUMNS}
         FROM files f ${SYMBOL_JOINS}
         WHERE ${where}
         ORDER BY s.id, f.branch
       ) x
       ORDER BY ${opts.order}
       LIMIT @limit`,
      params,
    );
  }
}
