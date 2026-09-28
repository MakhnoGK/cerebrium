import { inject, injectable } from "tsyringe";
import type { CodeContext } from "@cerebrium/contracts/code";
import type {
  EnrichedRow,
  NeighborStub,
  SearchRow,
  SymbolDirEntry,
  SymbolLookup,
  VectorRow,
} from "@cerebrium/contracts/types";
import { toEnvelope } from "@cerebrium/contracts/types";
import { EdgeType, MemoryKind, SYMBOL_TYPE } from "@cerebrium/contracts/vocab";
import {
  BRANCH_CODE_REPO_TOKEN,
  type BranchCodeRepo,
  type BranchScope,
  type CodeRepoRow,
  type CodeSymbolRow,
  type ResolvedCodeRef,
} from "@/domain/ports/storage";
import type { FileExtract } from "@/code/extract";
import { resolveCalls, resolveImports, resolverFrom, type Resolver } from "@/code/indexer";
import type { TextQuery } from "@/core/fts";

const NEIGHBOR_CAP = 100;
const RESOLVER_CACHE = 4;

export interface ScopeRequest {
  code_context?: CodeContext;
  repo?: string;
  branch?: string;
  as_of?: string;
}

export interface ResolvedScopes {
  scopes: BranchScope[];
  notes: string[];
}

interface Directory {
  resolver: Resolver;
  byId: Map<string, { qualified: string; kind: string }>;
}

// Everything that reads the per-branch index: which branches a call may see, and symbols in
// the shapes the existing tools already return.
@injectable()
export class CodeReadService {
  private readonly directories = new Map<string, Promise<Directory>>();

  constructor(@inject(BRANCH_CODE_REPO_TOKEN) private readonly code: BranchCodeRepo) {}

  // Code never comes from a branch where it cannot exist: a call reads its own branch, a
  // named one, or a repo's default branch — and says which in `notes`.
  async scopes(req: ScopeRequest): Promise<ResolvedScopes> {
    const notes: string[] = [];
    const scopes: BranchScope[] = [];
    const ctx = req.code_context;

    if (req.repo !== undefined) {
      const repos = await this.code.reposNamed(req.repo);

      if (!repos.length) {
        throw new Error(`no indexed repo is named '${req.repo}'. Run code_index in its checkout.`);
      }

      for (const repo of repos) {
        const fromContext = ctx?.remote_key === repo.remote_key ? ctx.branch : undefined;

        await this.addScope(scopes, notes, repo, req.branch ?? fromContext, req);
      }

      return { scopes, notes };
    }

    if (ctx !== undefined) {
      const repo = await this.code.repoByKey(ctx.remote_key);

      if (!repo) {
        notes.push(
          `${ctx.remote_key} is not indexed on the host yet; run code_index in this checkout.`,
        );

        return { scopes, notes };
      }

      await this.addScope(scopes, notes, repo, req.branch ?? ctx.branch, req);

      return { scopes, notes };
    }

    const all = await this.code.allRepos();

    for (const repo of all) {
      await this.addScope(scopes, notes, repo, req.branch, req);
    }

    if (scopes.length && req.branch === undefined) {
      notes.push(
        `no code context: reading default branches (${scopes
          .map((s) => `${s.repo.display_name}@${s.branch}`)
          .join(", ")}).`,
      );
    }

    return { scopes, notes };
  }

  async lookupByName(scopes: BranchScope[], name: string, limit: number): Promise<SymbolLookup[]> {
    return this.lookups(scopes, await this.code.symbolsByName(scopes, name, limit));
  }

  async lookupInFile(scopes: BranchScope[], path: string, limit: number): Promise<SymbolLookup[]> {
    return this.lookups(scopes, await this.code.symbolsInFile(scopes, path, limit));
  }

  // `get` for a symbol id: the parse it belongs to never changes, so it is found without a
  // scope; its neighbors are read on a branch that holds it, the caller's own if possible.
  async fetch(id: string, ctx?: CodeContext): Promise<Record<string, unknown> | undefined> {
    const detail = await this.code.symbolDetail(id);

    if (!detail) return undefined;

    const holding = await this.code.branchesHolding(detail.unit_id);
    const home =
      holding.find((h) => h.remote_key === ctx?.remote_key && h.branch === ctx.branch) ??
      holding.find((h) => h.remote_key === ctx?.remote_key) ??
      holding[0];
    const repo = home ? await this.code.repoByKey(home.remote_key) : undefined;
    const scope = repo && home ? { repo, branch: home.branch } : undefined;
    const row: CodeSymbolRow = {
      ...detail,
      repo_id: repo?.id ?? "",
      remote_key: repo?.remote_key ?? "",
      display_name: repo?.display_name ?? "",
      branch: home?.branch ?? "",
    };
    const envelope = toEnvelope(this.enriched(row, holding.length === 0));
    const { source, ...rest } = detail;

    return {
      ...envelope,
      content: detail.summary,
      edges: scope ? await this.neighbors(scope, row) : [],
      symbol: {
        ...this.facets(row),
        live_on: holding.map((h) => `${h.display_name}@${h.branch}`),
        unit_id: rest.unit_id,
      },
      source,
    };
  }

  async textRows(scopes: BranchScope[], text: TextQuery, cap: number): Promise<SearchRow[]> {
    return (await this.code.textSearch(scopes, text, cap)).map((r) => ({
      ...this.enriched(r),
      text_rank: r.text_rank,
    }));
  }

  async vectorRows(scopes: BranchScope[], embedding: number[], cap: number): Promise<VectorRow[]> {
    return (await this.code.vectorSearch(scopes, embedding, cap)).map((r) => ({
      ...this.enriched(r),
      distance: r.distance,
      chunk_text: r.summary,
      chunk_heading: null,
    }));
  }

  async resolveRefs(
    srcIds: string[],
    scopes: BranchScope[],
  ): Promise<(ResolvedCodeRef & { row: EnrichedRow })[]> {
    return (await this.code.resolveRefs(srcIds, scopes)).map((ref) => ({
      ...ref,
      row: this.enriched(ref.symbol),
    }));
  }

  enriched(row: CodeSymbolRow, retired = false): EnrichedRow {
    return {
      id: row.id,
      memory_kind: MemoryKind.MIRROR,
      type: SYMBOL_TYPE,
      title: row.qualified,
      project: row.display_name || null,
      valid_from: row.parsed_at,
      invalidated_at: retired ? row.parsed_at : null,
      rev: 1,
      updated: row.parsed_at,
      content: row.summary,
      edge_count: 0,
      use_count: 0,
      last_used_at: null,
    };
  }

  private facets(row: CodeSymbolRow): SymbolLookup["facets"] {
    return {
      repo: row.display_name,
      remote_key: row.remote_key,
      branch: row.branch,
      path: row.path,
      lang: row.lang,
      symbol_kind: row.kind,
      name: row.name,
      qualified: row.qualified,
      signature: row.signature,
      start_line: row.start_line,
      end_line: row.end_line,
    };
  }

  private async addScope(
    scopes: BranchScope[],
    notes: string[],
    repo: CodeRepoRow,
    wanted: string | undefined,
    req: ScopeRequest,
  ): Promise<void> {
    const asOf = req.as_of === undefined ? {} : { asOf: req.as_of };
    const fallback = repo.default_branch;

    if (wanted !== undefined) {
      const row = await this.code.branch(repo.id, wanted);

      if (row?.retired_at === null) {
        scopes.push({ repo, branch: wanted, ...asOf });

        return;
      }

      if (req.branch !== undefined || fallback === null || fallback === wanted) {
        notes.push(`${repo.display_name}@${wanted} is not indexed on the host.`);

        return;
      }

      notes.push(
        `${repo.display_name}@${wanted} is not indexed yet; reading the default branch ` +
          `${fallback} instead. Run code_index to index ${wanted}.`,
      );
    }

    if (fallback === null) {
      notes.push(`${repo.display_name} has no default branch recorded; name a branch.`);

      return;
    }

    const row = await this.code.branch(repo.id, fallback);

    if (row?.retired_at !== null) {
      notes.push(`the default branch ${repo.display_name}@${fallback} is not indexed.`);

      return;
    }

    scopes.push({ repo, branch: fallback, ...asOf });
  }

  private async lookups(scopes: BranchScope[], rows: CodeSymbolRow[]): Promise<SymbolLookup[]> {
    const out: SymbolLookup[] = [];

    for (const row of rows) {
      const scope = scopes.find((s) => s.repo.id === row.repo_id && s.branch === row.branch);

      out.push({
        envelope: toEnvelope(this.enriched(row)),
        facets: this.facets(row),
        neighbors: scope ? await this.neighbors(scope, row) : [],
      });
    }

    return out;
  }

  // The structural edges of one symbol on one branch, resolved the way the SQLite indexer
  // resolved them at write time.
  private async neighbors(scope: BranchScope, sym: CodeSymbolRow): Promise<NeighborStub[]> {
    const dir = await this.directory(scope);
    const stubs = new Map<string, NeighborStub>();
    const add = (id: string, edge: string, direction: "out" | "in"): void => {
      const target = dir.byId.get(id);
      const key = `${id}\0${edge}\0${direction}`;

      if (!target || id === sym.id || stubs.has(key) || stubs.size >= NEIGHBOR_CAP) return;

      stubs.set(key, { id, type: SYMBOL_TYPE, title: target.qualified, edge, direction });
    };

    for (const d of await this.code.definesOf(sym.id)) {
      if (d.src === sym.id) add(d.dst, EdgeType.DEFINES, "out");
      else add(d.src, EdgeType.DEFINES, "in");
    }

    const own = (await this.code.unitRefs([sym.unit_id])).get(sym.unit_id);

    if (own) {
      const ex = extractOf(own);

      for (const p of resolveCalls(dir.resolver, sym.path, sym.lang, ex)) {
        if (p.src === sym.id) add(p.dst, EdgeType.CALLS, "out");
      }

      if (sym.kind === "module") {
        for (const p of resolveImports(dir.resolver, sym.path, ex))
          add(p.dst, EdgeType.IMPORTS, "out");
      }
    }

    const callers = await this.code.callersOf(scope, sym.name);
    const importers = await this.code.importersOf(scope, sym.name, sym.path);
    const refs = await this.code.unitRefs([
      ...new Set([...callers, ...importers].map((u) => u.unit_id)),
    ]);

    for (const c of callers) {
      const ex = refs.get(c.unit_id);

      if (!ex) continue;

      for (const p of resolveCalls(dir.resolver, c.path, c.lang, extractOf(ex))) {
        if (p.dst === sym.id) add(p.src, EdgeType.CALLS, "in");
      }
    }

    for (const i of importers) {
      const ex = refs.get(i.unit_id);

      if (!ex) continue;

      for (const p of resolveImports(dir.resolver, i.path, extractOf(ex))) {
        if (p.dst === sym.id) add(p.src, EdgeType.IMPORTS, "in");
      }
    }

    return [...stubs.values()];
  }

  private async directory(scope: BranchScope): Promise<Directory> {
    const branch = await this.code.branch(scope.repo.id, scope.branch);
    const key = [scope.repo.id, scope.branch, scope.asOf ?? "", branch?.indexed_at ?? ""].join(
      "\0",
    );
    let dir = this.directories.get(key);

    if (!dir) {
      dir = this.code.directory(scope).then((entries) => ({
        resolver: resolverFrom(
          entries.map((e): SymbolDirEntry => ({
            node_id: e.id,
            path: e.path,
            name: e.name,
            qualified: e.qualified,
            symbol_kind: e.kind,
          })),
        ),
        byId: new Map(entries.map((e) => [e.id, { qualified: e.qualified, kind: e.kind }])),
      }));

      void dir.catch(() => this.directories.delete(key));
      this.directories.set(key, dir);

      while (this.directories.size > RESOLVER_CACHE) {
        this.directories.delete(this.directories.keys().next().value!);
      }
    }

    return dir;
  }
}

function extractOf(refs: {
  imports: FileExtract["imports"];
  calls: FileExtract["calls"];
}): FileExtract {
  return {
    symbols: [],
    defines: [],
    imports: refs.imports,
    calls: refs.calls,
    moduleExternalId: "",
  };
}
