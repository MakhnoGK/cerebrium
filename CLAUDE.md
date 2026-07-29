# CLAUDE.md — cerebrium

## What this project is

A DB-as-source-of-truth memory system for AI agents: a single TypeScript MCP server (stdio) owning one SQLite file, with FTS5 + sqlite-vec + a typed knowledge graph over append-only, revisioned nodes. Agents are the only writers; the human never edits data by hand. It distinguishes episodic memory (write-once records of what happened, relevance decays) from semantic memory (durable facts, maintained via revisions and validity windows). Token economy drives all tool design: search returns compact envelopes, content is fetched by id.

The design contracts are documented in `README.md` (concepts, tools, ranking model) and enforced by the test suite. If code and a documented contract disagree, treat it as a bug; if a contract seems wrong or ambiguous, stop and ask rather than silently reinterpret it.

## Invariants — never violate, never "temporarily" bypass

1. **One writer process.** Only this MCP server touches the DB file. No sidecar scripts, no second process, no direct sqlite3 CLI writes in tooling. (Read-only inspection via CLI is fine.) If a worker thread is ever used for embedding inference, only the main thread touches the DB. — The `cerebrium-daemon` is the *one* sanctioned exception and is not a "sidecar": it runs this same codebase (the same per-aggregate repositories), and the `worker_lease` elects it as the **sole** embedding-drain writer, so exactly one process ever drains the queue. The `cerebrium-stats` CLI opens the DB `readonly` and never writes.
2. **Append-only revisions.** Never `UPDATE` or `DELETE` a `revisions` row. Current content = latest rev.
3. **No hard deletes.** Any table. Soft-delete via `invalidated_at` only. Superseded data stays queryable via `history=true`.
4. **FTS in the write transaction.** The FTS index must never be stale relative to node content. Embeddings are the one sanctioned async exception (queue table).
5. **Envelopes by default.** No tool returns full node content unless explicitly asked by id. Any new tool or field must justify its token cost.
6. **Episodic is write-once.** `update` on an episodic node is an error by design — don't "fix" it.
7. **Provenance everywhere.** Every mutation records its `session_id`; every tool call appends an `events` row.

## Schema changes

- **Migrations are the single source of truth.** `openDatabase()` builds a DB purely by running `src/db/migrations/000_baseline.sql -> NNN` in order; it never executes `schema.sql`. `000_baseline.sql` is a frozen snapshot and must never be edited — any change is a new idempotent, numbered migration (`src/db/migrations/NNN_name.sql`). A migration needing computation SQLite can't express (e.g. recomputing a content-addressed hash) may be a `.cjs` module exporting `up(db)`, applied synchronously by the runner in filename order.
- `src/db/schema.sql` is a **derived, human-readable snapshot** of the current end state — never executed. Keep it updated in the same commit as a migration; the drift-guard test (`test/migrations.test.ts`) fails if it stops matching what the migrations build.
- Any schema change requires: migration + updated schema.sql snapshot + tests exercising the new columns/tables + a line in the CHANGELOG section of README.
- Enum-like vocabularies (`memory_kind`, node `type`, edge `type`, consolidation kind/status, event action) are defined once in `src/core/vocab.ts` as **TypeScript string enums** and referenced by validation and tests. Extending a vocabulary is a normal change; repurposing an existing value is forbidden. Zod validates them with `z.nativeEnum(...)`, which emits the same JSON Schema as the old string-literal unions — the agent-facing tool schemas must not change when a vocabulary is refactored.
- A vocabulary belongs in `vocab.ts`, never in a port. A port may *narrow* one (e.g. `GenerationTaskKind = ConsolidationKind.DISTILL | ConsolidationKind.MERGE`), but must not redeclare its members.

## Conventions

- TypeScript strict mode (`strictTypeChecked` lint); no `any` in exported signatures. `npm run check` (typecheck + eslint + prettier + tests) gates every commit.
- No ORM. All SQL lives in the per-aggregate repositories under `src/db/repositories/*` (prepared statements, named clearly), exposed through the barrel `src/db/repositories/index.ts`. Consumers inject the specific repos they need — there is no `Repo` god-object; `src/db/repo.ts` is a types-only re-export barrel. The cross-aggregate write/read primitives are in `src/db/repositories/internal.ts`. Tools contain no SQL.
- **Layers, innermost first. The direction is enforced by `no-restricted-imports` in `eslint.config.js` — a violation fails `npm run check`.**
  - `src/core/` — pure primitives (ids, vocab, tokens, chunk, fts, types). No db/fs/process deps, no outward imports at all.
  - `src/domain/ports/` — the interfaces + DI tokens the inner layers own (`Clock`, `EmbeddingProvider`, `RerankProvider`, `ConsolidationProvider`). May import `@/core` only.
  - `src/application/services/` — use-case services (`NodeService`, `MemoryService`, `SessionService`, `HintsService`, `EmbeddingService`, `ConsolidationService`, `DaemonService`).
  - Adapters/infra — `src/db/`, `src/code/`, `src/embeddings/`, `src/rerank/`, `src/consolidation/`, `src/runtime/`. Implement the ports; never import delivery.
  - `src/presentation/mcp/` — the MCP transport (`server.ts`, `adapters/`) and every tool under `tools/`. The outermost layer; nothing may import it.
  - Composition roots — `src/server.ts`, `src/daemon.ts`, `src/stats-cli.ts` wire the container and may import anything.
- Import via the `@/*` alias (-> `src/*`), `@test/*` in tests. **Parent-relative imports (`../…`) are lint-banned** — they resolve differently per tool/IDE. Sibling `./…` is fine. Barrels (`index.ts`) are the public entry for a folder — members import each other by direct path to avoid cycles.
- ⚠️ **Type-vs-value imports are load-bearing, in both directions.** An interface imported as a value breaks the esbuild bundle (`npm run build`, invisible to `tsc`); a constructor-injected class imported with `import type` erases `design:paramtypes` and makes tsyringe inject `undefined` at runtime (invisible to everything). Interfaces and type aliases → always `type`. Classes, enums, and tokens → always value imports. Never blanket-enable `consistent-type-imports`.
- One directory per MCP tool under `src/presentation/mcp/tools/<name>/{index.ts,metadata.ts}`. `metadata.ts` exports `{ name: ToolName, description, schema: z.ZodRawShape }`; `index.ts` exports a `class XxxTool implements McpTool<Schema, Response>` with `getMetadata()` and `invoke(args)` (no ctx). The `@tool()` class decorator registers it transiently under `TOOL_TOKEN`; `Server` receives the whole set via `@injectAll(TOOL_TOKEN)` and `ToolOutputAdapter` wraps `invoke` into the MCP `{content}`/`{isError}` envelope. Adding a tool = a new directory + a side-effect import in `src/presentation/mcp/tools/index.ts`. Tool input validation with Zod at the boundary; the repo layer assumes valid input.
- IDs are ULIDs; timestamps are UTC ISO-8601 strings. Everywhere.
- MCP tool descriptions are user-facing documentation for consuming agents: every change to a tool's behavior updates its description string in the same commit.
- Errors returned to agents are actionable sentences ("episodic memories are write-once; write a new node"), never stack traces or codes alone.

## Commands

- `npm run check` — typecheck + lint + format check + full suite. The single gate; must pass before any task is done.
- `npm test` / `npm run test:watch` — full suite (Vitest) / watch mode.
- `npm run typecheck` — `tsc --noEmit`. One root `tsconfig.json` covers `src` + `test` + `scripts`, so every tool and every IDE resolves `@/*` identically and tests are genuinely type-checked. `npm run lint` / `lint:fix` — ESLint. `npm run format` / `format:check` — Prettier (imports are auto-sorted into layer groups by `@ianvs/prettier-plugin-sort-imports`).
- `npm run build` — tsup (esbuild) bundle of the three bins to `dist/` + copy migrations (`scripts/copy-assets.mjs`).
- ⚠️ **`npm run build` is NOT part of `npm run check`.** esbuild catches a class of import error that `tsc` cannot (see the type-vs-value note above), and a broken bundle has landed unnoticed three times. After any change that moves files or rewrites imports, run `npm run build` **and** smoke-test the bundle over stdio — a successful build does not prove DI still resolves:
  ```sh
  printf '%s\n%s\n' \
   '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"s","version":"1"}}}' \
   '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"session_start","arguments":{}}}' \
   | MEMORY_DB_PATH=.tmp/smoke.db MEMORY_EMBED_PROVIDER=local-null node dist/server.js
  ```
  A real `tools/call` exercises tsyringe constructor injection end to end; `tools/list` alone does not (but should report **16** tools).
- `npm run dev` — run the server on stdio against a throwaway DB (`MEMORY_DB_PATH=.tmp/dev.db`).
- `npm run inspect` — MCP inspector session against the dev DB (verify tool schemas render correctly).

If a command above doesn't exist yet, creating it is part of the current task — keep the names.

## Testing rules

- Every invariant has at least one test that tries to violate it and asserts failure.
- Tests use the `local-null` embedding provider; the suite must pass offline with no model download and no API keys.
- Ranking behavior is tested with fixed clocks (inject `now`) — no `sleep`-based decay tests.
- End-to-end scenarios (multi-session flows from the briefs' acceptance criteria) live in `test/e2e/` and run as part of `npm test`.
- Never weaken or delete a failing test to make a task pass. If a test contradicts a brief, stop and ask.
- Test files are `kebab-case.test.ts` (never `snake_case`). Fixtures under `test/fixtures/` are stand-ins for arbitrary external source — they are excluded from lint, prettier and the TS project, and their relative imports and formatting are deliberate; never "tidy" them.
- **Naming + structure follow a fixed convention** (see `test/code-repo.test.ts` as the reference):
  - `describe(...)` is a capitalized noun phrase naming the subject under test (the unit/behavior group) — e.g. `Repo.applyFileIndex`, `Write-time reconcile`. Never a `should…`, never a placeholder like `phase 3`.
  - `it(...)`/`test(...)` reads `should <expected outcome> when <condition>`, lowercase, mirroring exactly what the body asserts — e.g. `should be a no-op when an unchanged file set is re-applied`.
  - Each test body is marked with `// Given` (arrange), `// When` (act), `// Then` (assert) comments. Collapse to `// Given / When` when setup and action are one line; repeat `// When / Then` per segment when a test drives several independent act-assert steps. These structural markers are the one sanctioned exception to the "keep comments minimal" rule — they carry no rationale, only phase labels.

## Consolidation

- Consolidation (link discovery, distillation, dedup/merge, Tier-1 mirror prune) runs in the `cerebrium-daemon` via `ConsolidationWorker` under its own `worker_lease` (role `"consolidation"`), only when the embedding backlog is empty — the one-writer invariant holds. Detection is deterministic SQL (kNN over stored vectors, provider-free); the *apply* writes are atomic repo methods (`NodesRepo.applyDistillation`/`applyMerge`) that never hard-delete and never mutate `revisions` — they invalidate + supersede + stamp `consolidated_at`.
- **Generation is a pluggable adapter** (the `ConsolidationProvider` port lives in `src/domain/ports/consolidation-provider.ts`; the adapters and their prompts/parsers in `src/consolidation/`, mirroring the reranker): `MEMORY_CONSOLIDATE` selects `manual` (default) | `off` | `command` | `http`. The daemon always performs the DB write; the provider only produces text. The default `manual` provider does not generate — it keeps the suite offline (no keys, no model), so **tests must never depend on a real provider**.
- **Posture is per-behavior config**, read at point of use (`src/consolidation/config.ts`, `MEMORY_CONSOLIDATE_*`): `off` | `suggest` | `auto`. Balanced defaults ship `auto` for cheap/reversible (links, prune) and `suggest` for destructive (distill, merge). `suggest` routes to the `consolidation_candidates` queue and the `consolidate_suggest`/`consolidate_apply` tools; `auto` applies inline. Changing a default is a normal change; keep the "never auto-author a merged/distilled body without a generating provider" rule.
- The `http` provider targets a local Ollama in the sibling `cerebrium-models/` directory (self-contained binary + model; **not** in this repo, never committed — it holds multi-GB weights).

## Scope discipline

Don't scaffold speculatively — the *(future)* columns already in the schema are the entire allowed footprint of not-yet-built features. **Shipped:** code indexing, external mirrors, the reranker, the `worker_lease`/daemon, consolidation, and the clean-architecture layering above. **Still deferred:** Tier-2 hard reclaim of dead mirrors (physical delete + VACUUM) — it needs a narrow amendment to invariant #3 (no hard deletes) limited to derived `mirror` nodes; do not implement it without that sign-off.

Layering work that is deliberately **not** done yet, so don't treat its absence as an oversight:
- `src/application/` still imports `src/db/` repositories directly. Depending on repository *ports* instead is a real future step (and the seam a remote/service-core split would need) — the lint rules intentionally permit it today.
- `src/consolidation/worker.ts` and `src/embeddings/worker.ts` are application services living in adapter folders; they belong in `src/application/` when the infra folders are reorganized under `src/infrastructure/`.
- Invariant #7 (provenance) is currently **not satisfied**: tools stopped appending `events` rows during the DI refactor. It should return as a decorator at the tool boundary, not a line in each handler. Until then `StatsRepo.techStats().rerank_usage` reads 0 and one `rerank.test` case is skipped.

## Working style

- Understand the relevant contract (README + existing code + tests) before implementing a tool or behavior.
- Small commits, one concern each. Migration and code that uses it may share a commit.
- Before ending a work session, ensure: tests green, README current, no TODOs without an owner note.
- When a design question isn't answered by the docs or this file — ask, don't assume. A short question costs a minute; an unwound wrong assumption costs a day.
