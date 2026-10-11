# ANTIGRAVITY.md — cerebrium

## What this project is

A DB-as-source-of-truth memory system for AI agents: a TypeScript kernel owning one Postgres store (pg_search BM25 + pgvector + a typed knowledge graph) over append-only, revisioned nodes, served to agents through a stdio MCP plugin. Agents are the only writers; the human never edits data by hand. It distinguishes episodic memory (write-once records of what happened, relevance decays) from semantic memory (durable facts, maintained via revisions and validity windows). Token economy drives all tool design: search returns compact envelopes, content is fetched by id.

The design contracts are documented in `README.md` (concepts, tools, ranking model) and enforced by the test suite. If code and a documented contract disagree, treat it as a bug; if a contract seems wrong or ambiguous, stop and ask rather than silently reinterpret it.

## Repository layout

An npm-workspaces monorepo. Each workspace is one deliverable or one shared layer, and `eslint.config.js` enforces the direction between them — a violation fails `npm run check`.

- `packages/contracts` (`@cerebrium/contracts/*`) — the wire both sides share: RPC framing, deadlines and protocol version (`rpc.ts`), the vocabularies (`vocab.ts`), the data types that cross the wire (`types.ts`), keyset pages (`page.ts`). Depends on nothing else in the repo.
- `packages/kernel` (`@/*` inside it, `@cerebrium/kernel/*` from an app) — the memory kernel: storage, retrieval, code index, consolidation, use cases, and their MCP and RPC presentation. Tests in `packages/kernel/test` (`@test/*`), dev tooling in `packages/kernel/scripts` (`@scripts/*`). May not depend on an app.
- `apps/host` (`@host/*`) — cerebrium-host: the daemon, the runner, their workers and CLIs, the container (`apps/host/Dockerfile`) and the files the release copies to the GPU laptop (`apps/host/deploy/`).
- `apps/plugin` (`@plugin/*`) — cerebrium-plugin: the stdio MCP server agents launch (`src/server.ts`), the skill (`skill/`), the rules and hooks (`install/`), and the installer (`scripts/agent-*.ts`).
- `apps/dashboard-api`, `apps/dashboard-web` — the web dashboard (NestJS BFF, React UI). Scaffolds only.

The host and the plugin never import each other. Every bin is still bundled flat into the root `dist/`, which is what the local install and every agent host point at. The one exception is cerebrium-plugin's remote-only server (`apps/plugin/src/plugin-server.ts`), built by `apps/plugin/tsup.config.ts` into `apps/plugin/dist/server.js` as one self-contained file: it is composed from `packages/kernel/src/remote-container.ts`, never from `container.ts`, and `apps/plugin/test/plugin-bundle.test.ts` fails if a storage backend, model runtime, parser or any non-builtin import reaches it.

## Invariants — never violate, never "temporarily" bypass

1. **One writer process.** Only the `cerebrium-daemon` on the host opens the store for writing. No sidecar scripts, no second writer, no direct `psql` writes in tooling (read-only inspection is fine). Agent hosts run the plugin, which registers no database and resolves the use-case tokens over the daemon's socket or TCP listener. Inside the daemon, **read pool** workers each hold their own read-only connection, and the **embedding model** lives in a worker that touches no database at all; a read-pool worker gets a provider that refuses to embed. Only the daemon's main thread ever *writes*, every pool worker is read-only and fails rather than writing, and the `worker_lease` gates the background writer roles (embedding drain, consolidation), so exactly one process runs each. Scripts and the `cerebrium-stats` CLI open the store `readonly` (`default_transaction_read_only`).
2. **Append-only revisions.** Never `UPDATE` or `DELETE` a `revisions` row. Current content = latest rev.
3. **No hard deletes.** Any table holding a record. Soft-delete via `invalidated_at` only. Superseded data stays queryable via `history=true`. — The **derived vector index** (`chunk_vectors`, `code_vectors`) is the one sanctioned exception, because it records nothing: every row is recomputable from `chunks.text`, and the `chunks` row it derives from is still only ever soft-deleted. `dropVector` is the single place that exercises it. This does **not** extend to `chunks`, `revisions`, `nodes`, `edges`, or any mirror table.
4. **FTS in the write transaction.** The FTS index must never be stale relative to node content. Embeddings are the one sanctioned async exception (queue table).
5. **Envelopes by default.** No tool returns node content unless explicitly asked by id, and `get` will return part of a body (`outline`/`sections`) rather than all of it when asked. Any new tool or field must justify its token cost.
6. **Episodic is write-once.** `update` on an episodic node is an error by design — don't "fix" it.
7. **Provenance everywhere.** Every mutation records its `session_id`; every tool call appends an `events` row.

## Schema changes

- **Migrations are the single source of truth.** The store is Postgres; its schema is `packages/kernel/src/db/postgres/migrations/000_baseline.sql -> NNN` (`.sql` only), applied in order under an advisory lock by the first writer; readers refuse an unmigrated store. `000_baseline.sql` is frozen and must never be edited — any change is a new idempotent, numbered migration. The database must sort text in byte order (`--locale=C`), which startup checks, because timestamps and ULIDs are compared as text.
- Any schema change requires: migration + tests exercising the new columns/tables + a line in the CHANGELOG section of README.
- Enum-like vocabularies (`memory_kind`, node `type`, edge `type`, consolidation kind/status, event action) are defined once in `packages/contracts/src/vocab.ts` as **TypeScript string enums** and referenced by validation and tests. Extending a vocabulary is a normal change; repurposing an existing value is forbidden. Zod validates them with `z.nativeEnum(...)`, which emits the same JSON Schema as the old string-literal unions — the agent-facing tool schemas must not change when a vocabulary is refactored.
- A vocabulary belongs in `vocab.ts`, never in a port. A port may *narrow* one (e.g. `GenerationTaskKind = ConsolidationKind.DISTILL | ConsolidationKind.MERGE`), but must not redeclare its members.

## Conventions

- TypeScript strict mode (`strictTypeChecked` lint); no `any` in exported signatures. `npm run check` (typecheck + eslint + prettier + tests) gates every commit.
- No ORM. Storage is one async port per aggregate in `packages/kernel/src/domain/ports/storage/*` (an interface plus its `*_REPO_TOKEN`); consumers `@inject` the specific ports they need — there is no `Repo` god-object. The implementations live in `packages/kernel/src/db/postgres/*` and are bound by `registerPostgresRepositories`. `KERNEL_TOKENS` includes every storage token (the `Store` itself included), so a port that goes unbound fails the role-parity test. Every write runs through `PgDatabase.tx`: one in-process write lane plus a store-wide advisory lock, with the transaction's client held in AsyncLocalStorage so nested repository calls join it (a nested `tx` is a savepoint). The cross-aggregate write/read primitives are in `packages/kernel/src/db/postgres/internal.ts`. Tests run against Postgres too: `npm run pg:up` starts the server `npm test` expects. A unit of work spanning several ports goes through a port method that takes the steps as a callback (`ConsolidationRepo.resolveCandidateAtomically`). Tools contain no SQL.
- **Layers, innermost first. The direction is enforced by `no-restricted-imports` in `eslint.config.js` — a violation fails `npm run check`.**
  - `packages/contracts/src/` and `packages/kernel/src/core/` — pure primitives (vocab, types, rpc, page in contracts; ids, tokens, chunk, fts, wikilinks in core). No db/fs/process deps, no outward imports at all.
  - `packages/kernel/src/domain/ports/` — the interfaces + DI tokens the inner layers own (`Clock`, `EmbeddingProvider`, `ConsolidationProvider`). May import `@/core` and contracts only.
  - `packages/kernel/src/application/services/` — use-case services (`NodeService`, `MemoryService`, `SessionService`, `HintsService`, `EmbeddingService`, `ConsolidationService`, `CodeIndexService`, `EventLogService`, `DaemonService`); `packages/kernel/src/application/errors/` — the typed errors a use case throws, mapped to a message at the tool boundary.
  - Adapters/infra — `packages/kernel/src/db/`, `packages/kernel/src/code/`, `packages/kernel/src/embeddings/`, `packages/kernel/src/consolidation/`, `packages/kernel/src/runtime/`. Implement the ports; never import delivery. They provide *capabilities*, not orchestration: `packages/kernel/src/code/` walks/parses/extracts/resolves, while the indexing use case that sequences them and writes lives in `CodeIndexService`.
  - `packages/kernel/src/presentation/mcp/` — the MCP transport (`server.ts`, `adapters/`) and every tool under `tools/`. The outermost layer; nothing may import it.
  - Composition roots — `apps/plugin/src/server.ts` and `apps/host/src/{daemon,runner,stats-cli,service-cli,healthcheck,read-worker,embed-worker}.ts` wire the container and may import anything in the kernel.
- Import via the path aliases (see **Repository layout**): `@/*` inside the kernel, `@cerebrium/contracts/*` and `@cerebrium/kernel/*` from an app, `@test/*` for kernel test helpers. **Parent-relative imports (`../…`) are lint-banned** — they resolve differently per tool/IDE. Sibling `./…` is fine. Barrels (`index.ts`) are the public entry for a folder — members import each other by direct path to avoid cycles.
- ⚠️ **Type-vs-value imports are load-bearing, in both directions.** An interface imported as a value breaks the esbuild bundle (`npm run build`, invisible to `tsc`); a constructor-injected class imported with `import type` erases `design:paramtypes` and makes tsyringe inject `undefined` at runtime (invisible to everything). Interfaces and type aliases → always `type`. Classes, enums, and tokens → always value imports. Never blanket-enable `consistent-type-imports`.
- One directory per MCP tool under `packages/kernel/src/presentation/mcp/tools/<name>/{index.ts,metadata.ts}`. `metadata.ts` exports `{ name: ToolName, description, schema: z.ZodRawShape }`; `index.ts` exports a `class XxxTool implements McpTool<Schema, Response>` with `getMetadata()` and `invoke(args)` (no ctx). The `@tool()` class decorator registers it transiently under `TOOL_TOKEN`; `Server` receives the whole set via `@injectAll(TOOL_TOKEN)` and composes `ToolOutputAdapter(AuditedTool(tool))` — `AuditedTool` satisfies invariant #7 by appending the `events` row for every call (success and failure), `ToolOutputAdapter` wraps the result into the MCP `{content}`/`{isError}` envelope. Adding a tool = a new directory + a side-effect import in `packages/kernel/src/presentation/mcp/tools/index.ts` + a `ToolName`->`EventAction` entry in `adapters/tool-action.ts` (a total `Record`, so a missing one fails `tsc`). Tool input validation with Zod at the boundary; the repo layer assumes valid input.
- **Event detail is declarative, never a call in a handler.** A tool that wants more than a bare audit row implements the optional `describeEvent(args, result)` from the `McpTool` contract, returning one `ToolEvent`, a list of them (one row per repo, as `code_index` does), or `null`. It may override `session_id` when the call mints one (`session_start`). Telemetry the response must not carry travels on a module-private `Symbol` key — invisible to `JSON.stringify`, so it costs the agent nothing.
- IDs are ULIDs; timestamps are UTC ISO-8601 strings. Everywhere.
- MCP tool descriptions are user-facing documentation for consuming agents: every change to a tool's behavior updates its description string in the same commit.
- Errors returned to agents are actionable sentences ("episodic memories are write-once; write a new node"), never stack traces or codes alone.

## Commands

- `npm run check` — typecheck + lint + format check + full suite. The single gate; must pass before any task is done.
- `npm test` / `npm run test:watch` — full suite (Vitest) / watch mode.
- `npm run typecheck` — `tsc --noEmit`. One root `tsconfig.json` covers every workspace, so every tool and every IDE resolves the aliases identically and tests are genuinely type-checked. `npm run lint` / `lint:fix` — ESLint. `npm run format` / `format:check` — Prettier (imports are auto-sorted into layer groups by `@ianvs/prettier-plugin-sort-imports`).
- `npm run build` — `build:bins` (tsup bundle of every bin, flat, to the root `dist/` + copy migrations via `scripts/copy-assets.mjs`; the only part the host image builds) then `build:plugin` (the self-contained plugin server to `apps/plugin/dist/server.js`).
- ⚠️ **A green build is NOT a working bundle.** esbuild catches a class of import error that `tsc` cannot (see the type-vs-value note above), and a broken bundle has landed unnoticed three times — but the DI half is invisible to both. `npm run check` now ends with `npm run smoke:bundle`, which boots the plugin bundle over stdio against an unreachable host and calls `session_start` for real: a `tools/call` exercises tsyringe constructor injection end to end, where `tools/list` alone does not.
- `npm run agent:setup` — report what each agent host (Claude Code, Codex, Antigravity, pi) still needs to use Cerebrium as memory; `-- --apply` installs it, `-- --verify` proves it. Read-only without `--apply`, and it never touches the store. The doctrine it installs lives in `apps/plugin/install/`; see `apps/plugin/install/hosts.md` for the per-host surfaces.
- `npm run pg:up` — the local Postgres the tests and the dev loop use. `npm run daemon` runs a dev daemon from `dist/` against it, with `CEREBRIUM_HOME=.tmp/dev`; `npm run dev`, `npm run stats` and `npm run inspect` (MCP inspector, to check tool schemas render) talk to that daemon. Run `npm run build:bins` first.

If a command above doesn't exist yet, creating it is part of the current task — keep the names.

## Testing rules

- Every invariant has at least one test that tries to violate it and asserts failure.
- Tests use the `local-null` embedding provider; the suite must pass offline with no model download and no API keys.
- Ranking behavior is tested with fixed clocks (inject `now`) — no `sleep`-based decay tests.
- End-to-end scenarios (multi-session flows from the briefs' acceptance criteria) live in `packages/kernel/test/e2e/` and run as part of `npm test`.
- Never weaken or delete a failing test to make a task pass. If a test contradicts a brief, stop and ask.
- Test files are `kebab-case.test.ts` (never `snake_case`). Fixtures under `*/test/fixtures/` are stand-ins for arbitrary external source — they are excluded from lint, prettier and the TS project, and their relative imports and formatting are deliberate; never "tidy" them.
- **Naming + structure follow a fixed convention** (see `packages/kernel/test/branch-code.test.ts` as the reference):
  - `describe(...)` is a capitalized noun phrase naming the subject under test (the unit/behavior group) — e.g. `The per-branch code index`, `Write-time reconcile`. Never a `should…`, never a placeholder like `phase 3`.
  - `it(...)`/`test(...)` reads `should <expected outcome> when <condition>`, lowercase, mirroring exactly what the body asserts — e.g. `should be a no-op when an unchanged file set is re-applied`.
  - Each test body is marked with `// Given` (arrange), `// When` (act), `// Then` (assert) comments. Collapse to `// Given / When` when setup and action are one line; repeat `// When / Then` per segment when a test drives several independent act-assert steps. These structural markers are the one sanctioned exception to the "keep comments minimal" rule — they carry no rationale, only phase labels.

## Consolidation

- Consolidation (link discovery, distillation, dedup/merge, Tier-1 mirror prune) runs in the `cerebrium-daemon` via `ConsolidationWorker` under its own `worker_lease` (role `"consolidation"`), only when the embedding backlog is empty — the one-writer invariant holds. Detection is deterministic SQL (kNN over stored vectors, provider-free); the *apply* writes are atomic repo methods (`NodesRepo.applyDistillation`/`applyMerge`) that never hard-delete and never mutate `revisions` — they invalidate + supersede + stamp `consolidated_at`.
- **Generation is a pluggable adapter** (the `ConsolidationProvider` port lives in `packages/kernel/src/domain/ports/consolidation-provider.ts`; the adapters and their prompts/parsers in `packages/kernel/src/consolidation/`, selected by name from the `BACKENDS` registry): `MEMORY_CONSOLIDATE` selects `manual` (default) | `off` | `command` | `http`. The daemon always performs the DB write; the provider only produces text. The default `manual` provider does not generate — it keeps the suite offline (no keys, no model), so **tests must never depend on a real provider**.
- **Posture is per-behavior config**, read at point of use (`packages/kernel/src/consolidation/config.ts`, `MEMORY_CONSOLIDATE_*`): `off` | `suggest` | `auto`. Balanced defaults ship `auto` for cheap/reversible (links, prune) and `suggest` for destructive (distill, merge). `suggest` routes to the `consolidation_candidates` queue and the `consolidate_suggest`/`consolidate_apply` tools; `auto` applies inline. Changing a default is a normal change; keep the "never auto-author a merged/distilled body without a generating provider" rule.
- The `http` provider targets a local Ollama in the sibling `cerebrium-models/` directory (self-contained binary + model; **not** in this repo, never committed — it holds multi-GB weights).

## Scope discipline

Don't scaffold speculatively — the *(future)* columns already in the schema are the entire allowed footprint of not-yet-built features. **Shipped:** code indexing, the `worker_lease`/daemon, consolidation (with per-role model routing), and the clean-architecture layering above. The MS MARCO cross-encoder reranker was removed in #17 and is not coming back on this evidence. External mirrors (`source_register`/`mirror_upsert`/`mirror_status`, the `mirror_sources` registry, `stale_sources`) were removed in the migration's Phase 3: their rows stay in `mirror_sources`/`mirror_records` and as legacy `mirror` nodes, but nothing writes or reads the registry any more. **Still deferred:** Tier-2 hard reclaim of dead mirrors (physical delete + VACUUM) — it needs a narrow amendment to invariant #3 (no hard deletes) limited to derived `mirror` nodes; do not implement it without that sign-off.

Layering work that is deliberately **not** done yet, so don't treat its absence as an oversight:
- The adapters still live at `packages/kernel/src/{embeddings,consolidation,code,runtime}/` rather than under `packages/kernel/src/infrastructure/`. They are already in the correct dependency position, so this is a rename, not a re-layering — and the two workers are application services that already sit in `packages/kernel/src/application/workers/`; do not move them into infrastructure.
- `packages/kernel/src/application/errors/` holds only the two code-index errors. The general typed-error vocabulary (`InvariantViolation`/`NotFound`/`WriteOnceViolation`) and the boundary mapping are still to come; the ~35 bare `throw new Error` calls across `packages/kernel/src/` are the backlog, not the pattern.

## Working style

- Understand the relevant contract (README + existing code + tests) before implementing a tool or behavior.
- Small commits, one concern each. Migration and code that uses it may share a commit.
- Before ending a work session, ensure: tests green, README current, no TODOs without an owner note.
- When a design question isn't answered by the docs or this file — ask, don't assume. A short question costs a minute; an unwound wrong assumption costs a day.
