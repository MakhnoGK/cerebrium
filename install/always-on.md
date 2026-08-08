<!-- cerebrium:start -- generated from install/always-on.md; edit there, then re-run the setup -->

# Agent memory (Cerebrium)

`Cerebrium` is your cross-session working memory and the single durable knowledge base — a
stdio MCP server owning one SQLite file (FTS5 + vector search + a typed graph). It is where
you record and recall everything across sessions: facts and how-tos learned, decisions made
(with reasons), entities, and where you left off. Agents are the only writers.

## Retrieval precedence — Cerebrium first

For any recall, **search Cerebrium first.** It holds what was already learned and distilled
across sessions, returns compact envelopes cheaply, and is the fastest path to "do we already
know this?". Anything durable you then learn from code, an issue tracker, or the user you
**write back to Cerebrium**, so the next first search finds it.

## Session lifecycle

- **`session_start` first**, before any other memory tool. It is the sole source of agent
  session ids. Copy the returned `session_id` verbatim into every subsequent call; never
  invent, guess, transform, or reuse one from another task. If it is unavailable, call
  `session_start` again. Read its budgeted working set to orient.
- **`checkpoint` before ending a substantial work block**: summary, decisions with reasons,
  open threads, touched node ids — so the next session resumes cleanly.

## Tools

- **`search`** — find memories. Compact envelopes plus a `best_chunk` snippet, often enough to
  answer without a `get`. `mode:'text'` is cheapest, `mode:'vector'` pure semantic, default is
  hybrid. `history:true` only for "what did we try before". **Search before writing.**
- **`get`** — full content + edges for specific ids; the only tool returning full content. Take
  *part* of a long node: `outline:true` lists sections for almost nothing, `sections:[…]`
  returns just the ones you name.
- **`write`** — create a node: `semantic` for durable facts/decisions/entities/howtos/tasks,
  `episodic` for a record of what happened. One fact per node. A `similar_existing` hint means
  STOP and prefer `update` or `invalidate`+`supersedes` over a near-duplicate. Always pass
  `parent_node_id`: copy an exact live node id to create `relates_to`, or pass `null` for an
  intentionally isolated node. Never infer or invent it.
- **`update`** / **`invalidate`** / **`restore`** — revise a semantic node (episodic is
  write-once); soft-delete, passing `superseded_by` when a newer node replaces it; undo a
  wrong retirement with id, history and edges intact.
- **`link`** — connect two nodes with a typed edge (`references`/`documents`/`derived_from`/
  `supersedes`/`relates_to`); edges drive graph expansion at search time.
- **`code_index`** / **`code_lookup`** — index a repo into `symbol` mirror nodes; look code up
  structurally by `name` or `file`. Use `search` with `types:['symbol']` for code by meaning.
- **`source_register`** / **`mirror_upsert`** / **`mirror_status`** — mirror curated external
  records (issues, incidents, docs) into `mirror` nodes. The server holds no credentials: you
  fetch with the source's own tools, then upsert. Curate; never bulk-dump.
- **`consolidate_suggest`** / **`consolidate_apply`** — review and resolve what the background
  sweep queued. **`stats`** — operational snapshot, no content.

Every session/node/candidate id is opaque. Copy it exactly from the tool that returned it;
never synthesize one. References to invalidated nodes are rejected, with the terminal live
successor named when there is exactly one; retry with that returned id only after checking it.

## Code is a mirror, not authored knowledge

`symbol` nodes are derived from source and maintained only by `code_index` — never
`write`/`update` them by hand. When you learn something *about* code (a decision, a gotcha,
why it is shaped that way), write a normal `semantic` node and `link` it to the symbol with a
`documents` edge; that link survives re-indexing.

For "where is X / what calls it / how does X work" in an **indexed** repo, query Cerebrium
before scanning files — envelopes and exact source-by-id cost far less than reading or
grepping. Reserve file reads for what the mirror cannot cover (non-indexed languages, configs,
docs), for editing (disk is authoritative — always re-read before an edit), and when the index
is stale (refresh with `code_index`, it is incremental).

**The mirror locates and explains; disk is the source of truth for edits.**

The full usage discipline — good vs bad examples, ranking behavior, mirror recipes — lives in
the `cerebrium` skill, which is installed alongside this block.

<!-- cerebrium:end -->
