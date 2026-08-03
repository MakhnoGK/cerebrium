# cerebrium

**Persistent, cross-session memory for AI agents — one SQLite file behind a single stdio MCP server.**

Cerebrium gives an LLM agent (such as Claude Code) a durable knowledge base it can
search, write to, and reason over across sessions. One TypeScript process owns one
SQLite database that combines **FTS5 full-text search**, **vector search
(sqlite-vec)**, and a **typed knowledge graph** over append-only, revisioned nodes.
The agent is the only writer; nothing is ever hard-deleted; search returns compact
*envelopes* and full content is fetched by id, so retrieval stays token-cheap.

It distinguishes **episodic** memory (write-once records of *what happened*, relevance
decaying with age) from **semantic** memory (durable facts, maintained through
revisions). Search is hybrid — FTS5 bm25 and vector KNN fused with Reciprocal Rank
Fusion, re-scored by a memory model, then expanded one hop over the graph — with an
optional cross-encoder reranker, an asynchronous embedding pipeline drained by a
background daemon, in-process tree-sitter code indexing, credential-free external-source
mirrors, and a consolidation sweep that distils episodic memory into semantic knowledge.

A personal R&D project exploring long-term memory for agents, used daily with Claude Code.

## Architecture

Clean-architecture layers, no ORM, one directory per MCP tool:

```
src/
  core/            pure primitives — ids, vocab, tokens, chunking, FTS, types (no I/O)
  domain/ports/    interfaces the inner layers own — Clock, Embedding/Rerank/Consolidation
                   providers, and the declarative config mechanism
  application/     services/ (node, memory, session, hints, embedding, consolidation,
                             code index, event log)
                   workers/  (embedding drain, consolidation sweep)
                   errors/   (typed errors a use case throws)
  db/              SQLite: migrations, per-aggregate repositories, schema snapshot
  infrastructure/  config sections + the environment source and registry
  embeddings/      pluggable embedding providers
  rerank/          pluggable cross-encoder reranker (second-stage precision)
  code/            tree-sitter code analysis (walk, parse, extract, resolve edges)
  consolidation/   pluggable generation adapter (manual / command / http)
  runtime/         process/IO glue (daemon spawn, pid file, system clock, main detection)
  presentation/    the MCP delivery layer — stdio server, audit + output adapters,
                   one dir per tool
  server.ts        stdio MCP server    daemon.ts  embedding drain    stats-cli.ts
```

Dependencies point inward only: `core` imports nothing, `domain/ports` sees only `core`,
adapters implement the ports, and nothing may import `presentation`. **That direction is
enforced by `no-restricted-imports` — a violation fails `npm run check`,** so the layering
is a build constraint rather than a convention.

The two background workers are application services that happen to run on a timer, so they
live in `application/workers/` rather than beside the adapters they drive.

All SQL lives in `src/db/repositories/*`; consumers inject the specific repositories they
need and tools contain no SQL. Enum-like vocabularies are TypeScript string enums defined
once in `core/vocab.ts`. IDs are ULIDs; timestamps are UTC ISO-8601. The full design
contract and invariants are in [`CLAUDE.md`](CLAUDE.md).

### Configuration

Settings are declared once as **config sections** and injected where they are used — no
module reads `process.env` at the point of use. A section declares each property's
default, validation, and (optionally) a legacy variable name in a single line:

```ts
@configSection()
export class RetrievalConfig extends SectionOf("retrieval", {
  symbolWeight:   num(0.5).positive().env("MEMORY_SYMBOL_WEIGHT"),
  dedupThreshold: num(0.92).range(0, 1).env("MEMORY_DEDUP_THRESHOLD"),
}) {}
```

Consumers inject the section they need (`SearchTool` takes `RetrievalConfig`), so a
dependency on configuration is as explicit as any other. A new property gets its variable
name for free, derived from the config path — adding `graphBase` to the section above
would read `MEMORY_RETRIEVAL_GRAPH_BASE` with no further bookkeeping. `.env(...)` exists
only to pin the names that predate the mechanism, which is why the two properties above
keep their original `MEMORY_SYMBOL_WEIGHT` / `MEMORY_DEDUP_THRESHOLD` spellings.

Two failure modes, deliberately different:

- **Unparseable** (`MEMORY_CONSOLIDATE_SIM=abc`) — falls back to the default *and* is
  recorded in `ConfigRegistry.ignored()`. A typo must not stop the process starting, but
  a silent fallback is how config drift stays invisible, so it is surfaced instead.
- **Out of range** (`MEMORY_CONSOLIDATE_SIM=1.5`) — fatal at startup, naming the variable,
  the config path, the constraint, and the offending value.

## Concepts

- **Node** — one memory. Has a `memory_kind`:
  - `episodic` — a record of *what happened* (a `checkpoint` or `event_note`).
    Write-once; relevance decays by *disuse* — the decay clock runs from the last
    `get`, not from the write, so a record that keeps being read stays reachable.
    **Cannot be updated.**
  - `semantic` — a durable fact/`decision`/`entity`/`howto`/`task`. Maintained
    via revisions; does not decay.
- **Revision** — every node's content is append-only revisions; the current
  content is the latest revision. Old revisions stay readable (`get` with `rev`).
- **Invalidation** — soft delete only. An invalidated node disappears from normal
  search but stays reachable with `history:true` and via `get`.
- **Envelope** — the compact form returned by `search`/`session_start`:
  `{ id, kind, type, title, summary, project, updated, rev, edges, invalidated }`.
  Full content is never in an envelope — call `get` with the ids you want.
  Hybrid search adds `matched`, and sometimes `best_chunk` / `via` (see below).
- **Chunk** — content-addressed slice of a node's current revision (split by
  headings then paragraphs, ~200–400 tokens). Each chunk gets one embedding.
  Editing one section leaves the other chunks' ids — and their vectors — untouched.
- **Embedding** — a 384-dim vector per chunk, computed **asynchronously** by an
  in-process worker. A node is fully findable via FTS the instant it's written;
  vector search catches up within seconds. `pending_embedding=1` until embedded.

## Hybrid search

`search` fuses two candidate lists — FTS5 bm25 and vector KNN — with Reciprocal
Rank Fusion, then applies the memory model (semantic steady, episodic decays by
disuse, often-fetched nodes carry a bounded importance boost, invalidated hidden
unless `history:true`), then optionally expands the graph.

- `mode`: `hybrid` (default), `text` (FTS only — cheapest), or
  `vector` (semantic only).
- `expand_graph` (default true): after fusion, run **personalized PageRank** over the
  local subgraph (2 hops, frontier-capped), seeded by the matched nodes in proportion to
  their relevance. Rank flows along edge-type conductance × the edge's stored weight,
  normalized by degree so a hub can't swallow the diffusion. This is multi-hop by
  construction, and a node backed by several independent hits beats one backed by a
  single strong hit. Only nodes the query did *not* match directly are scored this way,
  and a graph hit is capped at `0.3 ×` the top direct hit, so it never outranks it.
  `supersedes` is not traversable (a superseded node never surfaces), and neither is code
  structure (`calls`/`defines`/`imports`) — `documents` keeps the prose↔code join
  reachable. Ignored in `text` mode.
- The final cut is diversified with MMR (`MEMORY_MMR_LAMBDA`, `1.0` = off): among
  equally relevant candidates it prefers the ones that repeat each other least, so a
  fixed `limit` carries more distinct information. Relevance and redundancy are both
  min-max normalized within the candidate set — raw RRF and raw cosine are not on
  comparable scales. The top hit is always the most relevant one; candidates with no
  stored vector are never demoted; `text` mode is untouched.
- `as_of` (ISO-8601): run the search against the store **as it stood then** — only nodes
  already written and not yet invalidated at that instant, graph expansion included. It
  supersedes `history`, because it carries its own liveness rule: something invalidated
  since was valid then and belongs in the answer. `get` takes the same argument and
  returns the revision current at that time. This is how a decision taken on information
  that has since changed gets audited.
  **Limit worth knowing:** the FTS index and the vectors hold the *current* wording only,
  so `as_of` decides which nodes are considered — not how they were phrased then.
- `valid_at` (ISO-8601): the **other** time axis. `as_of` asks *when did we know it*;
  `valid_at` asks *when was it true*. A node carries an optional event window
  (`event_from`/`event_to`, set on `write`/`update`), so a note written today about an
  outage that ran last week records both. A node claiming no window counts as always
  valid, so `valid_at` narrows a result set rather than emptying it — most nodes never
  claim one. The two combine: `as_of` + `valid_at` is "what we believed on one date about
  what was true on another", which is the question an audit actually asks.
- Each result carries **`matched`**: `text` | `vector` | `both` | `graph`.
- Vector/both hits carry **`best_chunk`**: the first ~120 chars of the matched chunk
  — often enough to judge relevance without a `get`.
- Graph-expanded hits carry **`via`**: `{ node, edge }` — which top hit they hung
  off and the edge type, so the agent sees *why* something surfaced.
- **`context_notes`** (on any tool response, when relevant): short server-side notes
  — a superseded result, a parked/backlogged embedding queue, a duplicate hint.

## Quick start

Requires Node ≥ 22 (developed on Node 26; see `.nvmrc`/`engines`). `better-sqlite3`
and `sqlite-vec` are native modules that build/download on install.

**1 — Clone and build.**

```bash
git clone <this-repo> cerebrium && cd cerebrium
npm install
npm run build        # tsup (esbuild) -> dist/, copies migrations
```

**2 — Register it in Claude Code.** Use `-s user` so the memory server is available in
**every** project you open, not just one — a memory that only exists in one repo defeats
the point. Point it at the built `dist/server.js` by absolute path:

```bash
claude mcp add cerebrium -s user \
  --env MEMORY_DB_PATH=$HOME/.cerebrium/memory.db \
  -- node /ABSOLUTE/PATH/TO/cerebrium/dist/server.js
```

**3 — Verify.** `claude mcp list` should show `cerebrium`, and inside a Claude Code
session `/mcp` lists its tools (`session_start`, `search`, `write`, …). The SQLite file
and its `~/.cerebrium/models` cache are created on first use — no manual DB setup.

**4 — (Recommended) Install the skill** so the agent knows *how* to use the memory
(session lifecycle, search-before-write, retrieval economy), not just that the tools
exist:

```bash
cp -r skill/cerebrium ~/.claude/skills/cerebrium
```

That's it — open Claude Code in any project and the agent can call `session_start`,
`search`, `write`, `checkpoint`, and the rest. See [Tools](#tools) for the full surface
and [Skill for consuming agents](#skill-for-consuming-agents) for the usage discipline.

**One-time model download.** The default `local` embedding provider runs
[transformers.js](https://github.com/huggingface/transformers.js) in-process and
downloads `Xenova/multilingual-e5-small` (the ONNX build of
`intfloat/multilingual-e5-small`, ~120MB, quantized) to `MEMORY_MODEL_CACHE`
(default `~/.cerebrium/models`) on first embed. No API key, no daemon, no cost — a node
is searchable via FTS instantly and vector search catches up once the model is warm.

### Development & checks

```bash
npm run check        # typecheck + lint + prettier + Vitest + build — the gate
npm test             # full Vitest suite (offline, no keys — uses the local-null provider)
npm run build        # tsup bundle of the three bins to dist/
npm run inspect      # MCP inspector against a throwaway dev DB (verify tool schemas)
```

One root `tsconfig.json` covers `src` + `test` + `scripts`, so `tsc`, Vitest and every
editor resolve the `@/*` alias identically — and tests are genuinely type-checked rather
than merely transpiled. `npm run build` is part of the gate because esbuild catches a
class of import error `tsc` cannot: an interface imported as a value type-checks fine and
breaks the bundle.

To run against the TypeScript source without a build step (throwaway dev DB), register a
second server pointed at `tsx`:

```bash
claude mcp add cerebrium-dev -s user \
  --env MEMORY_DB_PATH=$HOME/.cerebrium/dev.db \
  -- npx tsx /ABSOLUTE/PATH/TO/cerebrium/src/server.ts
```

## Environment

Every variable below overrides one config-section property (see
[Configuration](#configuration)). A blank value reads as unset. Numeric values are used
as given — `0` means `0`, not "fall back to the default" — and a value outside its
declared range fails at startup rather than being quietly replaced.

| Var | Default | Meaning |
|-----|---------|---------|
| `MEMORY_DB_PATH` | `~/.cerebrium/memory.db` | SQLite file. `:memory:` for ephemeral. |
| `MEMORY_WORKING_SET_TOKENS` | `1500` | Token budget for the `session_start` working set. |
| `MEMORY_EMBED_PROVIDER` | `local` | `local` (transformers.js, downloads a model) or `local-null` (deterministic, offline, for tests). |
| `MEMORY_EMBED_MODEL` | `Xenova/multilingual-e5-small` | Model id for the `local` provider (dim 384). |
| `MEMORY_RERANK` | `off` | Second-stage search reranker: `off`, `local` (cross-encoder via transformers.js), or `local-null` (deterministic, offline, for tests). |
| `MEMORY_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Cross-encoder model id for the `local` reranker. |
| `MEMORY_MODEL_CACHE` | `~/.cerebrium/models` | Where model weights are cached (embeddings and reranker). |
| `MEMORY_DAEMON_IDLE_MS` | `300000` | How long the background drain daemon stays up with an empty queue before exiting (respawned on the next session). |
| `MEMORY_EMBED_BATCH` | `64` | Chunks the daemon embeds and commits per tick (one transaction). Larger = higher throughput, longer write-lock holds. |
| `MEMORY_DAEMON_ACTIVE_MS` | `0` | Pause between daemon ticks while a backlog exists. `0` = drain continuously (only an event-loop yield). |
| `MEMORY_DEDUP_THRESHOLD` | `0.92` | Cosine similarity above which a write reports `similar_existing`. Calibrated, not chosen — see below. |
| `MEMORY_DEDUP_LEXICAL_THRESHOLD` | `0.2` | Jaccard overlap gate for the write probe's lexical fallback (used only while nothing is embedded yet). A separate variable because Jaccard and cosine are different scales. |
| `MEMORY_CODE_ROOTS` | *(unset)* | Comma-separated `name=path` repos for `code_index` (e.g. `nebula-x=/Users/me/nebula-x,api=/Users/me/api`). Optional once a repo has been indexed by `path` — its root is remembered and re-indexable by name. |
| `MEMORY_SYMBOL_WEIGHT` | `0.5` | Knowledge-first ranking: search rank multiplier for code `symbol` mirrors as direct hits (down-weighted so authored/external-mirror knowledge ranks first; bypassed when the query asks for symbols). |
| `MEMORY_MMR_LAMBDA` | `0.7` | Diversity of the final `search` cut: `1.0` is pure relevance (off), lower trades relevance for less redundancy between returned hits. |
| `MEMORY_USE_WEIGHT` | `0.25` | Ceiling of the usage/importance boost a frequently fetched node earns (log-scaled, saturating at 20 fetches). `0` disables the prior. |
| `MEMORY_PPR_ALPHA` | `0.5` | Damping for graph expansion's personalized PageRank: higher diffuses further from the matched nodes, lower keeps rank near them. |
| `MEMORY_PPR_FRONTIER` | `500` | Max nodes pulled into the local subgraph PPR runs over, nearest first. |
| `MEMORY_CONSOLIDATE` | `manual` | Consolidation generation provider: `manual` (offline — queue clusters for an agent), `off`, `command` (subprocess: task JSON on stdin -> result JSON on stdout), or `http` (Ollama-style `/api/chat` with structured output). |
| `MEMORY_CONSOLIDATE_URL` | `http://127.0.0.1:11434/api/chat` | Endpoint for the `http` provider. |
| `MEMORY_CONSOLIDATE_MODEL` | `gemma4:12b-it-qat` | Model for the `http` provider. |
| `MEMORY_CONSOLIDATE_CMD` | *(unset)* | Command for the `command` provider. |
| `MEMORY_CONSOLIDATE_TIMEOUT_MS` | `60000` | Generation timeout for `http`/`command`. |
| `MEMORY_CONSOLIDATE_LINKS` | `auto` | Posture for `similar_to` link discovery: `off` \| `suggest` \| `auto`. |
| `MEMORY_CONSOLIDATE_DISTILL` | `suggest` | Posture for episodic->semantic distillation. |
| `MEMORY_CONSOLIDATE_MERGE` | `suggest` | Posture for semantic dedup/merge. |
| `MEMORY_CONSOLIDATE_PRUNE` | `auto` | Posture for Tier-1 mirror prune. |
| `MEMORY_CONSOLIDATE_LINK_PRUNE` | `auto` | Posture for retiring over-cap `similar_to` edges: `off` \| `auto`. |
| `MEMORY_CONSOLIDATE_RECONCILE` | `suggest` | Write-time dedup judgment posture: `suggest` returns a judged `reconcile` action (`noop`\|`update`\|`supersede`) + target in the `write` response; `off` disables it (the advisory `similar_existing` hint still fires). Never auto-applies. Needs a generating provider. |
| `MEMORY_CONSOLIDATE_ANNOTATE` | `auto` | Attribute-enrichment posture: `auto` mines keywords/tags/context for each semantic node during the sweep and folds them into its FTS text for wider recall; `off` skips it. Needs a generating provider. |
| `MEMORY_CONSOLIDATE_ANNOTATE_BATCH` | `50` | Max un-annotated semantic nodes enriched per sweep. |
| `MEMORY_CONSOLIDATE_SIM` | `0.9` | Cosine-similarity floor for clustering + link discovery. |
| `MEMORY_CONSOLIDATE_MERGE_SIM` | `0.925` | Similarity floor for treating two semantic nodes as duplicates. |
| `MEMORY_CONSOLIDATE_MIN_AGE_DAYS` | `14` | Minimum episodic age before it is eligible to distill. |
| `MEMORY_CONSOLIDATE_MIN_CLUSTER` | `3` | Minimum episodic cluster size to distill. |
| `MEMORY_CONSOLIDATE_MAX_LINK_DEGREE` | `5` | Max `similar_to` edges kept per node. Discovery stops at it; the prune stage retires edges outside the top-N by weight of *both* endpoints. |
| `MEMORY_CONSOLIDATE_INTERVAL_MS` | `300000` | Minimum gap between consolidation sweeps. |
| `MEMORY_CONSOLIDATE_LINK_BATCH` | `200` | Max candidate pairs examined for link discovery per sweep. |
| `MEMORY_CONSOLIDATE_DISTILL_BATCH` | `200` | Max episodic clusters considered for distillation per sweep. |
| `MEMORY_CONSOLIDATE_MERGE_BATCH` | `200` | Max duplicate semantic pairs considered per sweep. |
| `MEMORY_CONSOLIDATE_PRUNE_BATCH` | `200` | Max dead mirror nodes reconciled per sweep. |
| `MEMORY_CONSOLIDATE_LINK_PRUNE_BATCH` | `200` | Max over-cap `similar_to` edges retired per sweep. |
| `MEMORY_CONSOLIDATE_BACKFILL_BATCH` | `10` | Max pending candidates a newly-enabled provider drafts proposals for per sweep. |

The DB opens in WAL mode (`busy_timeout=15000`, foreign keys on) with the
`sqlite-vec` extension loaded. In practice one stdio server process runs per
Claude Code session, so several may open the same file: WAL serializes writers,
every write is an `IMMEDIATE` transaction wrapped in a busy-retry, and the async
embedding drain is single-elected via a `worker_lease` row, so nothing writes in
lockstep. Only the main thread of each process touches the DB.

**Background drain daemon.** The embedding queue is drained by a standalone
`cerebrium-daemon` process, not by the session that happens to be open. On
startup the MCP server spawns one detached (guarded by a `daemon.pid` file next to
the DB) if none is alive; the daemon holds the `embedding` lease, drains the queue,
and — once the queue has been empty for `MEMORY_DAEMON_IDLE_MS` — releases the model
and exits, to be respawned by the next session. This keeps the backlog moving even
after every Claude session has closed. If a daemon can't be spawned, the server
falls back to an in-process worker; the lease guarantees the two never double-write.

**Dimension.** The `chunk_vec` table is fixed at `FLOAT[384]` (the default model's
dimension). If a configured provider reports a different `dim`, the server fails
loudly at startup — changing the embedding dimension requires a new vector table
(recreate the DB or add a migration), not a silent reindex.

## Tools

Call `session_start` first; pass the returned `session_id` to every other tool
(an unknown id is auto-created, with a hint).

| Tool | When to use |
|------|-------------|
| `session_start` | Begin a work block. Returns `session_id` + a budgeted working set (recent facts, last 2 checkpoints *with content*, open tasks, stats). |
| `search` | Find memories. Hybrid (text + vector, RRF-fused) by default; `mode:'text'|'vector'` and `expand_graph` available. Envelopes only, with `matched`/`best_chunk`/`via`. Ranks semantic steadily, decays episodic by disuse; `history:true` includes invalidated nodes. **Search before writing.** |
| `get` | Fetch full content + edges for specific ids. The only tool that returns content. `include_revisions` for history; `rev` (single id) for a past revision. |
| `write` | Create a node. `semantic` for durable facts; `episodic` for records of what happened. Optional `links`. A semantic write runs a duplicate probe and may return `similar_existing`, each candidate carrying a `score` and a `confidence` (`high` = also clears the merge gate). |
| `update` | Append a revision to a **semantic** node (episodic is write-once). Old text stays reachable. Changed sections re-embed; unchanged ones keep their vectors. |
| `invalidate` | Soft-delete a node; optional `superseded_by` records the replacement via a `supersedes` edge. |
| `link` | Connect two existing nodes with a typed, directed edge (`references`/`documents`/`derived_from`/`supersedes`/`relates_to`). Edges drive graph expansion at search time. |
| `checkpoint` | Before ending a work block: writes an episodic checkpoint (Summary / Decisions / Open threads) linked to touched nodes, so the next session picks up where you left off. |
| `code_index` | Index/refresh source repos into `symbol` mirror nodes + code edges. Incremental (per-file hash-gate); run after pulling/changing a repo. Returns a compact per-repo summary, never code. |
| `code_lookup` | Exact structural code lookup: by `name` (simple/qualified) or `file`, returning symbol envelopes + `defines`/`calls`/`imports` neighbor stubs. Raw source via `get`. |
| `source_register` | Register/update an external mirror source for this deployment (`id`, `kind`, optional `project`/`freshness_hours`/`recipe`). Stores no credentials; the registry is empty by default. |
| `mirror_upsert` | Upsert curated external records into `mirror` nodes for a registered source. Idempotent by `(source, native_id)`; supply decision-worthy records only, never bulk. Compact count envelope + affected node ids. |
| `mirror_status` | List registered sources with freshness (last sync, hours stale, `stale`, live node count). `session_start` also surfaces stale sources. |
| `consolidate_suggest` | List pending consolidation candidates (`distill`/`merge`/`link`/`prune`) the background sweep queued for review — envelopes with score, member ids, and a proposal when pre-generated. |
| `consolidate_apply` | Resolve a candidate: `accept` applies it (write the `similar_to` edge / distilled fact / merge / prune), `reject` dismisses it. `override` supplies the summary/merged body for distill/merge. |
| `stats` | Operational snapshot (no content): embedding queue depth (backlog/parked/oldest/attempts histogram), content totals (nodes by kind, edges, chunks embedded vs pending, sessions, events), storage (DB + WAL bytes), drain health (provider, daemon alive, lease holder), and reranker usage (eligible vs actually reranked searches, candidates scored). `session_id` optional. |

Every tool call updates the session's `last_seen` and appends an `events` row — written at
the boundary by `AuditedTool`, on failures as well as successes, so provenance cannot be
forgotten by a new tool. A tool contributes the row's `node_id`/`detail` declaratively via
the optional `describeEvent(args, result)`; `stats`' reranker counters are derived from
those rows.

`search` and `get` make those rows a **retrieval-outcome log**: a search records its query
and the ids it returned in rank order, a `get` records the ids it was asked for and how
many resolved. Joining the two gives an implicit relevance signal (which results an agent
actually went on to read) without any extra instrumentation — and, because the detail
rides a `Symbol` key out of the tool, without a single token reaching the agent.

## Commands

Installed as `bin` entries (available on `PATH` after `npm link` / global install),
also runnable in-repo via `npm run <name>` against a throwaway dev DB.

| Command | What it does |
|---------|--------------|
| `cerebrium` | The MCP server (stdio). Registered in Claude Code. |
| `cerebrium-daemon` | The background embedding drain. Normally auto-spawned by the server; run manually to force a drain or to keep one resident. |
| `cerebrium-stats [--json]` | Read-only snapshot of the DB (same data as the `stats` tool). Safe to run anytime — it never writes — including when no server or daemon is up. |
| `npm run calibrate:report` | Read-only threshold calibration report against a real store: where the similarity gates should sit, and why. `--json`, `--all-scorers`, `--cross-encoder`. See *Calibrating the similarity gates*. |
| `npm run eval:retrieval` | Labelled relevance eval over a seeded 36-doc corpus. `--arm NAME:KEY=VAL` (repeatable) measures one configuration against another on identical documents, embeddings and queries — e.g. `--arm relevance:MEMORY_MMR_LAMBDA=1.0 --arm diverse:MEMORY_MMR_LAMBDA=0.7`. Reports MRR, nDCG@10, P@1, Recall@10 and Facet@3. See *Evaluating a ranking change*. |

## Code indexing

`code_index` walks configured repos (`MEMORY_CODE_ROOTS`) or an explicit `path`,
parses each source file with tree-sitter **in-process** (WASM, no daemon), and
mirrors its symbols into the graph. This runs kernel-side — reading files from disk
does not violate the single-writer invariant (that is about who writes the *DB*).

- **Supported languages:** TypeScript (`.ts`/`.mts`/`.cts`), TSX (`.tsx`),
  JavaScript (`.js`/`.jsx`/`.mjs`/`.cjs`), PHP (`.php` — classes, traits, interfaces,
  enums, functions, methods, consts), and Rust (`.rs` — structs, enums, traits, impl
  blocks with their methods, free functions, consts/statics, type aliases, macros, and
  nested `mod`s). The language registry (`src/code/languages.ts`) is a small map and the
  extractor dispatches per language, so adding Python/Go later is a new grammar + a
  handler, not a rewrite. Files with no known grammar are skipped and counted.
- **`symbol` mirror nodes** (`memory_kind='mirror'`, `type='symbol'`, `origin='repo'`)
  are *derived from source, not authored*: `write`/`update` on them are rejected. Each
  node's content is a compact **summary** (one-line signature + first doc-comment
  line) — that is what gets FTS-indexed and embedded. The raw source slice lives in
  the `symbols` table and is returned only by `get`. A symbol node's stable identity is
  `sha256(repo, path, qualified-name, kind)`, so re-indexing revises the same node and
  any `documents` edges you drew from a note survive.
- **Roots are remembered.** The first time a repo is indexed by explicit `path`, its root
  is stored in `code_repos`, so later runs can pass just `repo` (the name) even when
  `MEMORY_CODE_ROOTS` doesn't define it. "Index all" (no `repo`/`path`) covers both the
  configured roots and the remembered ones (env wins on a name clash).
- **Branch-agnostic, with provenance.** Symbol identity does not include the git branch —
  the index is a snapshot of whatever is on disk, so re-indexing after a branch switch makes
  it reflect that branch ("last indexed branch wins"; symbols that differ are re-embedded,
  files only on the other branch are soft-invalidated). For provenance, each index run records
  the root's git `branch`/`commit`/`dirty` in `code_repos` and reports it in the `code_index`
  and `stats` output. If you want isolated per-branch indexes, give each a distinct `repo`
  name (e.g. via a git worktree) rather than bouncing one repo across branches.
- **Incremental.** A per-file content hash (`code_files`) skips unchanged files
  entirely. A changed file re-parses; only symbols whose own source changed get a new
  revision, and a symbol re-embeds only when its summary actually changes. Symbols and
  files removed from source are **soft-invalidated** (never deleted; reachable with
  `history:true`).
- **Edges** (all provenance `system`, agent-uncreatable): `defines` (class->method,
  module->top-level), `imports` (resolved to repo-local files; third-party/aliased
  specifiers are dropped, not stored as dangling edges), and best-effort `calls`.
- **`calls` is best-effort and intra-repo only** — same-file names and imported symbols
  are resolved by name; dynamic dispatch and cross-module calls that need a type system
  are dropped. A precise call graph would require SCIP and is out of scope. `imports`
  cross-file edges forward-reference correctly because resolution runs after every
  file's symbols exist (a two-pass index within one run).
- **Import resolution differs by language.** TS/JS relative specifiers (`./x`) resolve
  to a repo file (extensions/`index` tried; third-party & path-aliased imports dropped).
  PHP `use` statements and Rust `use` paths are name-based (PHP PSR-4 / the Rust crate
  module tree both need config outside a single file, out of scope), so they and their
  calls (`Foo::bar()`/`$this->m()`, Rust `foo()`/`x.m()`/`Foo::bar()`) resolve **by symbol
  name repo-wide** — looser than TS, and ambiguous on duplicate names (first wins).
- **The payoff:** write a semantic decision/gotcha about code and `link` it to a symbol
  with a `documents` edge — a later `search` for that topic surfaces the symbol via
  graph expansion (`via:{edge:'documents'}`), straight from note to code.

**.gitignore support** is a pragmatic subset (comments, blank lines, `!` negation,
anchored & directory-only patterns, `*`/`**`/`?` globs, nested `.gitignore` files);
`node_modules`, `.git`, `dist`, `build`, and similar are always skipped, along with
binaries and files > 1 MB. Auto-refresh on `git pull` is not wired up — re-run
`code_index` after changes.

## External mirrors

Cerebrium can mirror curated records from the external tools an agent already has MCP access
to — GitLab, Jira/Confluence, Notion, Sentry, Grafana, Slack, TestRail, Tableau, Amplitude —
into `mirror` nodes, so they're searchable and linkable alongside the notes that explain them.

The design is **source-agnostic and credential-free**: the kernel never connects to an
external service and hard-codes no source. The *agent* fetches with the source's own MCP
tools and writes the results in; a deployment with a different toolset just registers
different sources, with no change to `src/`.

- **Registry (`mirror_sources`), empty by default.** `source_register` adds a per-deployment
  source instance (`id` e.g. `grafana-prod`, `kind` e.g. `grafana`, optional `project`,
  `freshness_hours`, `recipe`). A fresh clone has no sources and every tool still works.
- **Curated upsert.** `mirror_upsert { source_id, items }` writes decision-worthy records —
  each a compact markdown summary you compose, plus optional `url`/`facets`. Idempotent by
  `(source, native_id)`: identical content is a no-op, changed content adds a revision. It is
  **not** a bulk import; mirroring a whole channel would poison retrieval.
- **Open vocab.** A mirror node's `type` (`incident`, `thread`, `chart`, …) is free-form —
  a new source or record type needs no migration (same as `symbols.symbol_kind`). Nodes are
  ordinary `mirror` rows (`origin`=kind, `external_id`=`sha256(source_id\0native_id)`); the
  deep-link URL + facet JSON live in `mirror_records` and are returned only by `get`.
- **Freshness hook.** `mirror_status` reports each source's last sync + whether it's `stale`
  (enabled, past its `freshness_hours`, or never synced); `session_start` surfaces stale
  sources so the agent knows what to re-sync.
- **Retire + link.** Retire a stale record with `invalidate` (external mirrors are
  agent-curated; code symbols stay indexer-only). The payoff is `link`: draw
  `documents`/`references`/`relates_to` from a semantic note to a mirror record (or between
  records across sources), and a later `search` surfaces it via graph expansion.

Per-source **recipes** — how the agent fetches and maps each source — live in
`docs/mirrors/*.md` (a template + a worked `grafana-prod` example + stubs for the rest). They
are documentation the agent follows, not code the kernel runs.

## Consolidation

The `cerebrium-daemon` runs a background consolidation sweep (under its own
`worker_lease`, only when the embedding backlog is empty) that distils raw memory
into durable knowledge:

- **Knowledge-first ranking** — code `symbol` mirrors are down-weighted as direct
  search hits (`MEMORY_SYMBOL_WEIGHT`) so authored and external-mirror knowledge
  ranks first; a query that asks for symbols (`types:['symbol']`/`kinds:['mirror']`)
  bypasses the penalty.
- **Link discovery** — writes system `similar_to` edges between highly similar
  semantic nodes (kNN over stored vectors), improving graph expansion over time.
  Bounded by `MEMORY_CONSOLIDATE_MAX_LINK_DEGREE`: a node stops attracting new edges
  at the cap, and a prune stage retires stored edges that fall outside the top-N by
  weight of *both* endpoints — an edge that is a node's own best link is never cut,
  so pruning cannot strand a node outside the graph.
- **Distillation** — rolls up clusters of decayed episodics into one durable
  semantic fact, linked `derived_from` each source, stamping the sources
  `consolidated_at` (they stay queryable via `history`).
- **Dedup/merge** — folds near-duplicate semantic nodes into a canonical survivor,
  re-pointing edges and superseding the loser.
- **Tier-1 mirror prune** — soft-invalidates dead mirror nodes (orphaned symbols) so
  they leave retrieval.

Each behavior has an independent posture — `off` | `suggest` | `auto` (see the
`MEMORY_CONSOLIDATE_*` table above; the shipped defaults are *Balanced*: `auto` for
the cheap/reversible behaviors, `suggest` for the destructive ones). `suggest`
queues a candidate an agent reviews with `consolidate_suggest` / `consolidate_apply`;
`auto` applies directly. Distillation and merge need generation: choose a
`ConsolidationProvider` via `MEMORY_CONSOLIDATE` — `manual` (the default; the agent
authors the summary at apply time) or a bring-your-own `command`/`http` backend. A
self-contained local runtime (Ollama + a small model) for the `http` provider lives
in the sibling `cerebrium-models/` directory. Generation never runs in the tests
(the `manual` provider keeps the suite offline).

## Evaluating a ranking change

`npm run eval:retrieval` answers one question: *does this knob help on labelled data?* It
seeds a fixed 36-doc corpus (with edges, and with gold answers that cluster into facets)
into an in-memory DB, embeds it once, then runs the same queries through two or more
**arms** — named configuration overlays — sharing that one corpus and those embeddings, so
the only difference between arms is the knob.

```sh
npm run eval:retrieval -- --arm relevance:MEMORY_MMR_LAMBDA=1.0 --arm diverse:MEMORY_MMR_LAMBDA=0.7
```

`Facet@3` is deliberately read at a tighter cut than the relevance metrics: a diversity
stage trades relevance for distinct information, and at a window wide enough to hold every
gold answer that trade is invisible. Covering a facet with an *irrelevant* document does
not count.

**What this is not.** 36 docs in memory cannot reproduce the anisotropy or the candidate
starvation of a real 125k-node store, and the corpus contains no usage history, so an arm
that wins here has stopped being a guess — it has not become proven.

For that, `--db PATH` runs the same arms against a real store. It is opened **read-only**
and the session-hint write is stubbed out, so a run cannot modify the store it measures.
Gold labels are mined from the retrieval-outcome log: within one session, a node that `get`
fetched after a `search` returned it counts as relevant to that query — implicit relevance,
i.e. what the agent judged worth spending tokens on, not adjudicated truth. The run prints
how many labelled queries it found and refuses to score below 20 of them (`--min` lowers
the floor for a smoke test; numbers under it are noise).

Note the signal accrues slowly *by design*: envelopes and `best_chunk` are built so an
agent can usually answer without calling `get`, and a search nobody follows up on produces
no label.

## Calibrating the similarity gates

Three settings decide when two memories count as related — `MEMORY_DEDUP_THRESHOLD`
(the write-time probe), `MEMORY_CONSOLIDATE_SIM` (link discovery + episodic
clustering) and `MEMORY_CONSOLIDATE_MERGE_SIM` (destructive merge) — plus
`MEMORY_DEDUP_LEXICAL_THRESHOLD` for the probe's Jaccard fallback. **They are
measured, not chosen**, because a sentence embedder's cosine scale is compressed and
model-specific: on a single-domain corpus every pair of authored notes can sit inside
a ~0.85–1.00 band, so a threshold that looks conservative in the abstract fires on
everything, and a swap of the embedding model invalidates whatever was set before.

`npm run calibrate:report` measures where they belong, read-only, against a real
store. It has two arms, because only one gate has ground truth:

- **Labelled** — `consolidation_candidates` records every past merge verdict
  (`applied` / `dismissed`). That is a labelled set: the report scores those pairs,
  ranks candidate scorers by AUC, and prints precision/recall at each threshold, so
  `MEMORY_CONSOLIDATE_MERGE_SIM` is a trade you pick off a table rather than a guess.
  Alternative scorers stay registered behind `--all-scorers` so a rejected idea can be
  re-tested instead of re-argued.
- **Density** — the dedup and link gates have no verdicts, so they are set against a
  target *volume* instead: how often a write would surface a candidate, and how many
  edges link discovery would propose per node. A gate that flags most writes is noise
  whatever its precision.

Two properties of the measurement are worth knowing before quoting it. Candidates were
only ever detected above the gate in force at the time, so recall *below* that gate is
unmeasurable — the recall column is recall among proposed pairs. And a stored score
cannot be recomputed from today's vectors (content gets revised, and the detector's
similarity is asymmetric), so the report reads the recorded score and reports the drift
rather than pretending to reproduce it.

## Skill for consuming agents

`skill/cerebrium/SKILL.md` teaches a consuming agent (e.g. Claude Code) the
usage *discipline* — session lifecycle, search-before-write, retrieval economy,
episodic-vs-semantic — not the API. Install it by copying the folder into a skills
directory the agent loads:

```bash
cp -r skill/cerebrium ~/.claude/skills/cerebrium
```

## Backup (Litestream)

Streaming replication is not built in; run [Litestream](https://litestream.io)
alongside the server. Example `litestream.yml`:

```yaml
dbs:
  - path: /home/you/.cerebrium/memory.db
    replicas:
      - type: s3
        bucket: my-memory-backups
        path: cerebrium
        # or: type: file, path: /mnt/backup/cerebrium
```

`litestream replicate -config litestream.yml`. Restore with
`litestream restore -o memory.db s3://my-memory-backups/cerebrium`.
WAL mode (already on) is required for Litestream.


## Engineering highlights

- **DB-as-source-of-truth, append-only.** A database is built purely by running numbered
  migrations (`000_baseline.sql -> NNN`); `schema.sql` is a derived snapshot kept honest by
  a drift-guard test. Nothing is ever hard-deleted — invalidation is soft, and superseded
  data stays queryable with `history:true`.
- **Hybrid retrieval with a memory model.** FTS5 bm25 and vector KNN are fused with RRF,
  multiplied by a memory factor (semantic steady, episodic `exp(-age/14d)`), then expanded
  one hop over typed edges. An optional cross-encoder reranker adds a precision stage over
  the fused hits without touching the memory model.
- **Async embeddings, single-writer safe.** A node is findable via FTS the instant it is
  written; a 384-dim vector per content-addressed chunk is computed asynchronously, so
  editing one section re-embeds only that chunk. A standalone daemon drains the queue across
  sessions and idle-exits; a `worker_lease` elects exactly one drain writer, and every write
  is an `IMMEDIATE` transaction wrapped in busy-retry — so several session processes can
  share one SQLite file without lockstep writes.
- **In-process code indexing.** tree-sitter (WASM, no external process) mirrors
  TypeScript / JavaScript / PHP / Rust symbols into the graph, incrementally via a per-file
  content-hash gate, with `defines` / `imports` / best-effort `calls` edges. Link a semantic
  note to a symbol and a later search resurfaces the code by meaning via graph expansion.
- **Credential-free external mirrors.** The agent curates decision-worthy records from tools
  it already has MCP access to (GitLab, Jira, Sentry, Grafana, Notion, …) into searchable
  `mirror` nodes. The kernel connects to nothing, stores no credentials, and hard-codes no
  source — a different deployment just registers different sources, no code change.
- **Background consolidation.** Link discovery, episodic->semantic distillation, dedup/merge,
  and dead-mirror pruning run in the daemon, each with an independent `off`/`suggest`/`auto`
  posture. Generation is a pluggable adapter (`manual`/`command`/`http`), and the default
  keeps the entire test suite offline — no API keys, no model download.
- **Layering enforced by the build, not by discipline.** Dependencies point inward
  (`core` → `domain/ports` → `application` → adapters → `presentation`), and the direction
  is checked by lint rather than trusted to review — a wrong-way import fails `npm run check`.
  Providers are ports with swappable adapters, so changing how embeddings, reranking or
  consolidation are produced is a one-file change plus a class.
- **Configuration as declarative, injectable sections.** A setting is declared once —
  default, validation and env name together — and injected where it is used, so adding one
  is a single line and no module reads the environment at the point of use. Unparseable
  values fall back but are recorded and reportable; out-of-range values fail at startup
  rather than being silently replaced.
- **Performance-driven choices.** Batched commits took measured single-writer embedding
  throughput from ~30 to ~176 chunks/s; a benchmark showed CPU int8 inference beating
  CoreML/WebGPU for the 384-dim model, so there is no GPU dependency.

## License

[MIT](LICENSE).
