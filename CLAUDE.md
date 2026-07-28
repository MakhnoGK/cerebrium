# CLAUDE.md — cerebrium

## What this project is

A DB-as-source-of-truth memory system for AI agents: a single TypeScript MCP server (stdio) owning one SQLite file, with FTS5 + sqlite-vec + a typed knowledge graph over append-only, revisioned nodes. Agents are the only writers; the human never edits data by hand. It distinguishes episodic memory (write-once records of what happened, relevance decays) from semantic memory (durable facts, maintained via revisions and validity windows). Token economy drives all tool design: search returns compact envelopes, content is fetched by id.

The design contracts are documented in `README.md` (concepts, tools, ranking model) and enforced by the test suite. If code and a documented contract disagree, treat it as a bug; if a contract seems wrong or ambiguous, stop and ask rather than silently reinterpret it.

## Invariants — never violate, never "temporarily" bypass

1. **One writer process.** Only this MCP server touches the DB file. No sidecar scripts, no second process, no direct sqlite3 CLI writes in tooling. (Read-only inspection via CLI is fine.) If a worker thread is ever used for embedding inference, only the main thread touches the DB. — The `cerebrium-daemon` is the *one* sanctioned exception and is not a "sidecar": it runs this same codebase (same `Repo` layer), and the `worker_lease` elects it as the **sole** embedding-drain writer, so exactly one process ever drains the queue. The `cerebrium-stats` CLI opens the DB `readonly` and never writes.
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
- Enum-like vocabularies (`memory_kind`, node `type`, edge `type`) are defined once in `src/core/vocab.ts` and referenced by validation and tests. Extending a vocabulary is a normal change; repurposing an existing value is forbidden.

## Conventions

- TypeScript strict mode (`strictTypeChecked` lint); no `any` in exported signatures. `npm run check` (typecheck + eslint + prettier + tests) gates every commit.
- No ORM. All SQL lives in the per-aggregate repositories under `src/db/repositories/*` (prepared statements, named clearly), behind the `Repo` composition root in `src/db/repo.ts`. The cross-aggregate write/read primitives are in `src/db/repositories/internal.ts`. Tools contain no SQL.
- Module layout: pure domain in `src/core/` (ids, vocab, tokens, chunk, fts, types — no db/fs/process deps); process/IO in `src/runtime/`; data layer in `src/db/`; MCP handlers in `src/tools/`. Import via the `@/*` alias (-> `src/*`); no `.js` extension on relative imports. Barrels (`index.ts`) are the public entry for a folder — members import each other by direct path to avoid cycles.
- One file per MCP tool under `src/tools/`, each a `class XxxTool extends AbstractTool` (`src/tools/contracts/`) declaring `name` (a `ToolName` enum member), `description`, `schema` (a `z.ZodRawShape`), and `invoke(ctx, args)`. The base class's `callback` wraps `invoke` into the MCP `{content}`/`{isError}` envelope. Register by adding an instance to the `TOOLS` array in `src/tools/index.ts`; `server.ts` loops over it. Tool input validation with Zod at the boundary (args typed `TypeOf<ZodObject<typeof this.schema>>`); repo layer assumes valid input.
- IDs are ULIDs; timestamps are UTC ISO-8601 strings. Everywhere.
- MCP tool descriptions are user-facing documentation for consuming agents: every change to a tool's behavior updates its description string in the same commit.
- Errors returned to agents are actionable sentences ("episodic memories are write-once; write a new node"), never stack traces or codes alone.

## Commands

- `npm run check` — typecheck + lint + format check + full suite. The single gate; must pass before any task is done.
- `npm test` / `npm run test:watch` — full suite (Vitest) / watch mode.
- `npm run typecheck` — `tsc --noEmit`. `npm run lint` / `lint:fix` — ESLint. `npm run format` / `format:check` — Prettier.
- `npm run build` — tsup (esbuild) bundle of the three bins to `dist/` + copy migrations (`scripts/copy-assets.mjs`).
- `npm run dev` — run the server on stdio against a throwaway DB (`MEMORY_DB_PATH=.tmp/dev.db`).
- `npm run inspect` — MCP inspector session against the dev DB (verify tool schemas render correctly).

If a command above doesn't exist yet, creating it is part of the current task — keep the names.

## Testing rules

- Every invariant has at least one test that tries to violate it and asserts failure.
- Tests use the `local-null` embedding provider; the suite must pass offline with no model download and no API keys.
- Ranking behavior is tested with fixed clocks (inject `now`) — no `sleep`-based decay tests.
- End-to-end scenarios (multi-session flows from the briefs' acceptance criteria) live in `test/e2e/` and run as part of `npm test`.
- Never weaken or delete a failing test to make a task pass. If a test contradicts a brief, stop and ask.
- **Naming + structure follow a fixed convention** (see `test/code_repo.test.ts` as the reference):
  - `describe(...)` is a capitalized noun phrase naming the subject under test (the unit/behavior group) — e.g. `Repo.applyFileIndex`, `Write-time reconcile`. Never a `should…`, never a placeholder like `phase 3`.
  - `it(...)`/`test(...)` reads `should <expected outcome> when <condition>`, lowercase, mirroring exactly what the body asserts — e.g. `should be a no-op when an unchanged file set is re-applied`.
  - Each test body is marked with `// Given` (arrange), `// When` (act), `// Then` (assert) comments. Collapse to `// Given / When` when setup and action are one line; repeat `// When / Then` per segment when a test drives several independent act-assert steps. These structural markers are the one sanctioned exception to the "keep comments minimal" rule — they carry no rationale, only phase labels.

## Consolidation

- Consolidation (link discovery, distillation, dedup/merge, Tier-1 mirror prune) runs in the `cerebrium-daemon` via `ConsolidationWorker` under its own `worker_lease` (role `"consolidation"`), only when the embedding backlog is empty — the one-writer invariant holds. Detection is deterministic SQL (kNN over stored vectors, provider-free); the *apply* writes are atomic repo methods (`NodesRepo.applyDistillation`/`applyMerge`) that never hard-delete and never mutate `revisions` — they invalidate + supersede + stamp `consolidated_at`.
- **Generation is a pluggable adapter** (`src/consolidation/`, mirroring the reranker): `MEMORY_CONSOLIDATE` selects `manual` (default) | `off` | `command` | `http`. The daemon always performs the DB write; the provider only produces text. The default `manual` provider does not generate — it keeps the suite offline (no keys, no model), so **tests must never depend on a real provider**.
- **Posture is per-behavior config**, read at point of use (`src/consolidation/config.ts`, `MEMORY_CONSOLIDATE_*`): `off` | `suggest` | `auto`. Balanced defaults ship `auto` for cheap/reversible (links, prune) and `suggest` for destructive (distill, merge). `suggest` routes to the `consolidation_candidates` queue and the `consolidate_suggest`/`consolidate_apply` tools; `auto` applies inline. Changing a default is a normal change; keep the "never auto-author a merged/distilled body without a generating provider" rule.
- The `http` provider targets a local Ollama in the sibling `cerebrium-models/` directory (self-contained binary + model; **not** in this repo, never committed — it holds multi-GB weights).

## Scope discipline

Don't scaffold speculatively — the *(future)* columns already in the schema are the entire allowed footprint of not-yet-built features. **Shipped:** code indexing, external mirrors, the reranker, the `worker_lease`/daemon, and consolidation. **Still deferred:** Tier-2 hard reclaim of dead mirrors (physical delete + VACUUM) — it needs a narrow amendment to invariant #3 (no hard deletes) limited to derived `mirror` nodes; do not implement it without that sign-off.

## Working style

- Understand the relevant contract (README + existing code + tests) before implementing a tool or behavior.
- Small commits, one concern each. Migration and code that uses it may share a commit.
- Before ending a work session, ensure: tests green, README current, no TODOs without an owner note.
- When a design question isn't answered by the docs or this file — ask, don't assume. A short question costs a minute; an unwound wrong assumption costs a day.
