# Agent memory (Cerebrium)

`Cerebrium` is my cross-session working memory and the single durable knowledge
base — a stdio MCP server owning one SQLite file (FTS5 + vector search + a typed
graph). It is where I record and recall everything across sessions: facts and
how-tos I've learned, decisions I made (with reasons), entities, and where I left
off. I am the only writer. Source repo: `~/projects/personal/ai/cerebrium`.

## Retrieval precedence — Cerebrium first
For any recall, **search Cerebrium first.** It holds what I've already learned
and distilled across sessions, returns compact envelopes cheaply, and is the fastest
path to "do we already know this?". It is the authoritative source of durable project
knowledge (services, features, docs, decisions, gotchas). Anything durable I then
learn from code, Sentry, GitLab, or the user I **write back to Cerebrium** so the
next first search finds it — don't narrate durable findings to a scratch file or an
external wiki; they live in Cerebrium.

## Tools and when to call them
The MCP server is registered (user scope) as `cerebrium`; its tools appear as
`mcp__cerebrium__<tool>`.
- **`session_start`** — call FIRST, before any other memory tool, at the start of a
  task. Returns a `session_id` (pass it to every subsequent call) and a budgeted
  working set (recent facts, last checkpoints *with content*, open tasks, stats). Read
  it to orient.
- **`search`** — find memories. Returns compact envelopes + a `best_chunk` snippet,
  often enough to answer without a `get`. Default mode is hybrid (text + vector), good
  even with no shared keywords; `mode:'text'` is cheapest, `mode:'vector'` is pure
  semantic. Use `history:true` only for "what did we try before". **Search before writing.**
- **`get`** — fetch full content + edges for specific ids (the only tool returning full
  content). Call it only after `search`/`best_chunk` shows an id is worth the tokens.
  Take *part* of a long node rather than all of it: a vector hit reports the `section` its
  chunk sits under, and passing that back as `sections:[…]` returns just that part (naming
  a heading takes everything beneath it). `outline:true` lists the sections and their sizes
  for almost nothing. Neither combines with `rev`/`as_of`.
- **`write`** — create a node: `semantic` for durable facts/decisions/entities/howtos/
  tasks; `episodic` for a record of what happened. One fact per node. A `similar_existing`
  hint means STOP and prefer `update` or `invalidate`+`supersedes` over a near-duplicate.
  Each candidate carries a `score` and a `confidence`: `high` also clears the merge gate,
  so treat it as the same fact unless I can name the difference; `moderate` is worth a look.
  When a generating provider is on, `write` may also return a `reconcile` field with a
  judged action (`update`/`supersede` a named `target_id`, or `noop`) — act on it directly
  rather than re-deriving the duplicate decision. It is advice; the server never applies it.
- **`update`** — revise a `semantic` node (episodic is write-once); history is kept.
- **`invalidate`** — soft-delete; pass `superseded_by` when a newer node replaces it, which
  also moves the retired node's authored referrers onto the successor.
- **`restore`** — the inverse, for a retirement that was wrong (an auto-merge that swallowed
  a living index). Brings the node back with its id, revision history and edges intact —
  all three of which re-publishing under a new id would destroy.
- **`link`** — connect two existing nodes with a typed edge (`references`/`documents`/
  `derived_from`/`supersedes`/`relates_to`); edges drive graph expansion at search time.
- **`checkpoint`** — call BEFORE ending a substantial work block: summary, decisions
  (with reasons), open threads, touched node ids — so the next session resumes cleanly.
- **`code_index`** — index/refresh a repo into `symbol` mirror nodes + code edges
  (TS/TSX/JS/PHP/Rust). Run after pulling/changing a repo. Incremental (per-file hash-gate);
  returns a compact summary, never code. Pass `repo` (a configured `MEMORY_CODE_ROOTS`
  name — `cerebrium` is wired) or `path` (any directory). Indexing runs in-process in
  the one server (no second writer, so never index via a shell/hook).
- **`code_lookup`** — exact structural code lookup by `name` or `file`, returning symbol
  envelopes + `defines`/`calls`/`imports` neighbor stubs. Use `search` with
  `types:['symbol']` for code-by-meaning; `get` a symbol id for its raw source.
- **`source_register` / `mirror_upsert` / `mirror_status`** — mirror curated records from
  external tools (Sentry, GitLab, Jira, Notion, Grafana…) into `mirror` nodes so they are
  searchable and linkable beside the notes that explain them. The server holds **no
  credentials**: I fetch with the source's own MCP tools, then upsert. `session_start`
  lists stale sources. Curate — decision-worthy records only, never a bulk dump, which
  poisons retrieval. The payoff is the `link` from a semantic note to the record.
- **`consolidate_suggest` / `consolidate_apply`** — review what the background sweep queued
  (`distill`/`merge`/`link`/`prune`) and resolve it with `apply` or `reject`. Review
  destructive applies on index nodes with care; one has already eaten a hand-maintained
  index, which is what `restore` exists for.
- **`stats`** — operational snapshot, no content: embedding queue, content totals, storage,
  daemon/lease health, graph integrity (dangling edges, how many are repairable, stranded
  nodes — all three should read 0), reranker usage.

**Code is a mirror, not authored knowledge.** `symbol` nodes are derived from source
and maintained only by `code_index` — never `write`/`update` them by hand. When I learn
something *about* code (a decision, a gotcha, why it's shaped that way), I write a normal
`semantic` node and `link` it to the symbol with a `documents` edge; that note→code link
survives re-indexing and a later search surfaces the code via graph expansion.

## Code navigation — Cerebrium before `Read`/`Grep` (token discipline)
For any "where is X / what calls it / what's in this file / how does X work" question about
an **indexed** repo, query Cerebrium *before* scanning files — it returns compact envelopes
and exact source-by-id, far cheaper than reading or grepping whole files:
- Know the name or file → **`code_lookup`** (`name` or `file`) for the symbol plus its
  `defines`/`calls`/`imports` neighbor stubs; walk structure by following stubs, not by
  opening files.
- Know only the concept, not the name → **`search`** with `types:['symbol']`.
- Need the actual code of a symbol I've located → **`get <id>`** returns just that symbol's
  source slice, not the whole file.

Reserve `Read`/`Grep` for where the mirror can't help or can't be trusted:
1. **Coverage** — files the index doesn't cover: non-`TS/TSX/JS/PHP/Rust` (configs, SQL, docs,
   YAML), or a repo not wired into `MEMORY_CODE_ROOTS`.
2. **Editing** — the moment I'm about to change a file. `Edit` needs a fresh `Read` and
   disk is authoritative; never edit from the mirror.
3. **Staleness** — the mirror reflects the last `code_index` run (a branch/commit snapshot;
   check provenance `dirty`). If the file changed since — I just edited it, or the working
   tree is dirty — refresh with `code_index` (incremental, cheap) or read the file.

Rule of thumb: **the mirror locates and explains; disk is the source of truth for edits.**
Keeping the index fresh (`code_index` after pulls/edits) is what makes this discipline safe.

Full usage discipline (good vs bad examples) lives in the skill `cerebrium`
(`~/.claude/skills/cerebrium/SKILL.md`; source in `~/projects/personal/ai/cerebrium`).
When I distill code / Sentry / GitLab knowledge into something durable, it goes in
Cerebrium.

# Code comments

Keep comments minimal. Don't narrate what the code already says, don't restate
the diff, and don't add "// added this" / "// changed X" / step-by-step play-by-play
comments. Match the comment density of the surrounding code. When in doubt,
leave it out.

**No decision-making / rationale comments.** Do not justify a design choice
inline, narrate a tradeoff, explain "X so that Y, not Z", cite a ticket as
rationale, or describe why one approach was picked over another. That reasoning
belongs in the commit message or the MR description — never baked into the code
as prose. This includes test comments that restate the scenario or explain the
arithmetic of a fixture. Examples of what to delete:
- `// Business-rule guard runs after validation so a malformed range returns 400, not a misleading 409.`
- `// Fail-open: a Redis outage must not 500 the endpoint, so an unreadable store reports "idle".`
- `// Build off the prototype instead of the constructor because the base arity varies across branches.`

The only "why" comment that earns its place is a **terse one-line gotcha about
a real external trap** that will bite the next editor — a library quirk, an
ordering constraint the compiler won't enforce, a non-obvious API contract.
Not a justification of the code's own shape. When unsure whether a "why" is a
gotcha or a decision, it's a decision — cut it.

# Accessing Sentry

Self-hosted Sentry lives at `https://sentry.obrio.net` and is reachable through
the `sentry` MCP server (stdio, user scope — available in all repos). Use its
tools to inspect issues, events, traces, and run Seer analyses; prefer them over
raw API calls.

For anything the MCP doesn't cover, hit the API directly with the stored token:
```
curl -H "Authorization: Bearer $SENTRY_ACCESS_TOKEN" \
  https://sentry.obrio.net/api/0/organizations/
```
The personal access token is configured in the `sentry` MCP server entry in
`~/.claude.json`. Do not paste the token into code, notes, or commits.

# Accessing GitLab

Our GitLab is self-hosted at `https://git.obrio.net` (not gitlab.com). Use the
`glab` CLI, which is already authenticated against that host. Examples:
```
glab -R group/project mr list
glab -R group/project ci view
glab api projects/:id/...        # raw API when a subcommand is missing
```
Pass `-R <group>/<project>` (or run inside the repo) to target a project. The
`gitlab.com` host entry in `glab` is stale/unauthenticated — ignore it; all work
goes through `git.obrio.net`.

