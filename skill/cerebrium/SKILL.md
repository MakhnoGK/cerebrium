---
name: cerebrium
description: >-
  Use the cerebrium MCP server for durable, cross-session memory: orient at the
  start of a task, search before answering from scratch, record decisions and
  hand-offs. Trigger whenever you need to remember or recall project facts,
  decisions, how-tos, or "where did we leave off" across sessions.
---

# cerebrium — usage discipline

A DB-as-source-of-truth memory. You (the agent) are the only writer. Search returns
compact **envelopes**; fetch full content by id. Two memory kinds:

- **semantic** — a durable fact/decision/entity/howto/task. Maintained via `update`;
  does not decay. *A thing that should be true tomorrow.*
- **episodic** — a record of what happened (`checkpoint`, `event_note`). Write-once;
  decays with age. *A thing that happened this session.*

## Session lifecycle

1. **`session_start` first — always.** It is the sole source of agent session ids. Copy
   the returned `session_id` verbatim into every other call; never invent, guess,
   transform, or reuse one from another task. If you no longer have it, call
   `session_start` again. Read its working set before doing anything.
2. **`checkpoint` before ending any substantial work block.** A good checkpoint has:
   a `summary` (where you left off), `decisions` (each with its reason), `open_threads`
   (what to pick up next), and `touched_node_ids` (nodes you changed). This is how the
   next session knows where you stopped.

## Retrieval discipline

`search` -> read envelopes + `best_chunk` snippets -> `get` only the ids you actually need.

- The `best_chunk` snippet on a vector/both hit is often enough to judge relevance —
  don't `get` unless you need the full body. Tokens are the budget. (A hit whose
  `best_chunk` already opens with its `summary` ships no `summary`; that is not a
  missing field.)
- **When you do need a long node, take the part you need.** A vector hit also carries
  `section` — the heading the matched chunk sits under. Pass it straight back as
  `get sections:["H2: Ranking"]` and you get that section, not the whole body; naming a
  heading also takes everything beneath it. Unsure which part? `get outline:true` lists
  every section and its size for almost nothing. A narrowed `get` always returns the full
  outline too, so you can see what you skipped and ask for it.
- Sections read the current body, so they can't be combined with `rev`/`as_of`.
- `matched` tells you *how* a result surfaced: `text` (keyword), `vector` (meaning),
  `both` (strongest), `graph` (a neighbor of a top hit).
- A `graph` result carries `via: {node, edge}` — the node it hung off and the edge type.
  Follow these; they are curated context ("this howto **documents** that entity").
- Use `history: true` ONLY for "what did we try before / what changed" questions. It
  surfaces invalidated/superseded nodes (flagged) and drops time-decay.
- `mode: 'text'` is the cheapest exact keyword search; default `hybrid` is almost always
  what you want; `mode: 'vector'` for "find me something like this" with no shared words.
- **`kinds` is a real instruction to the vector branch, not just a post-filter.** The code
  index lives in its own vector pool, so `kinds:['semantic','episodic']` makes the search
  sweep authored memory exhaustively instead of splitting its candidate budget with a
  100x-larger symbol index. Pass it whenever the answer cannot be a code symbol — and
  `types:['symbol']` when it must be.

```
GOOD: search "retry backoff policy" -> envelope shows best_chunk "…exponential backoff,
      parked after 5 attempts…" -> answer directly, no get needed.
BAD:  search -> immediately get all 10 ids -> dump 8k tokens to read one sentence.

GOOD: search "consolidation posture" -> hit is a 9k plan index, section "H2: Ladder" ->
      get ids:[id] sections:["H2: Ladder"] -> ~600 chars instead of 9,000.
BAD:  get the whole plan index every session to re-read one table.
```

## Write discipline

**Search before every write.** If the write returns `similar_existing` (a near-duplicate
probe fired), STOP and reconsider:

- Same fact, now more correct? -> `update` the existing node (keeps history).
- Replaced by a genuinely new fact? -> `write` the new one, then `invalidate` the old with
  `superseded_by: <new id>`. That also moves the old node's referrers onto the new one.
- Genuinely distinct? -> proceed, and `link` them so the graph connects them.

**Treat every id as opaque.** Copy session, node, and candidate ids exactly from the tool
that returned them. Never synthesize, repair, shorten, or guess an id. A reference to an
invalidated node is rejected; when Cerebrium names one terminal live successor, inspect that
node and retry with its exact id if it is the intended target.

Every `write` must include `parent_node_id`. Use an exact live node id to create an atomic
`relates_to` edge, or `null` to state that the new node is intentionally isolated. Never
infer a parent from session history or invent one. Extra typed relationships still belong
in `links`.

Each candidate carries a `score` (cosine similarity, or lexical overlap before anything is
embedded) and a `confidence`. `high` means it also clears the merge gate — treat it as the
same fact unless you can name the difference. `moderate` means related enough to check.
Both gates are calibrated per deployment, so a candidate appearing at all is meaningful.

**Retiring the wrong node is recoverable.** If a supersede or an auto-merge takes out a
node that should have lived — a living index compressed into a lossy summary is the case
this exists for — call `restore` on it. It comes back with the same id, its whole revision
history and its edges. Re-publishing the content under a new id throws all three away.

One fact per node. Link liberally — edges are what make graph expansion work.

A long body draws a `context_notes` line saying so. It is advice, not a limit: a living
index node is *meant* to be long. Take it as a prompt to check whether the body is one
subject or several, and to give it headings either way — a body with headings can be read
in parts, one without any can only be fetched whole.

Episodic vs semantic, the decision rule:
- "We deployed X and hit error Y" -> **episodic** `event_note`.
- "X must be deployed before Y" -> **semantic** `fact`/`decision`.
- Ending a work block -> **`checkpoint`** (never a plain episodic note).

```
GOOD: search "token TTL" -> hit exists -> update it to "10 minutes", reason "shortened".
BAD:  write a second "Token TTL" fact -> two contradictory nodes, note-sprawl.

GOOD: write decision "Use RS256" with parent_node_id:null; write fact "JWKS rotates weekly"
      with parent_node_id:<decision id>;
      link src=decision dst=fact type=references.
BAD:  cram both into one node titled "auth stuff".
```

## Code

The kernel indexes source repos (TypeScript/TSX/JavaScript/PHP/Rust) into `symbol` mirror
nodes (functions, methods, classes, interfaces, types, enums, traits, consts,
modules) with code edges (`defines`/`imports`/`calls`). Symbols are **mirrors**: derived from source, not
authored — never `write`/`update` them by hand (both are rejected). They are
maintained by re-indexing.

- **After a repo changes** (you pulled, or edited files), call `code_index`. It is
  incremental: unchanged files are hash-gated and cost nothing; only changed symbols
  re-parse and re-embed; removed symbols are soft-invalidated. It returns a compact
  summary, never the code itself.
- **Find code by meaning** with `search` (`types:['symbol']` scopes to code); **find
  it by structure** with `code_lookup` (`name:` to resolve a symbol + its
  defines/calls/imports neighbors, `file:` to list a file's symbols). Then `get` an id
  for the raw `source` slice.
- **When you learn something ABOUT code** — a decision, a gotcha, why it's shaped this
  way — write it as a normal **semantic** node and `link` it to the relevant symbol
  with a `documents` edge. That note->code link survives re-indexing, and future
  searches traverse it: a search for the note's topic surfaces the symbol via graph
  expansion (`via:{edge:'documents'}`). This is the payoff — design notes that point
  straight at the code they describe.

```
GOOD: code_index -> search "token expiry" types:['symbol'] -> get the symbol -> write a
      decision "TTL is 15m because …" -> link documents -> symbol.
BAD:  write a semantic node describing what AuthService.validate does (that's a mirror —
      let the indexer own it; only record insight the code itself doesn't state).
```

## External mirrors

The kernel can mirror curated records from external tools (GitLab, Jira/Confluence, Notion,
Sentry, Grafana, Slack, TestRail, Tableau, Amplitude) into `mirror` nodes, so they're
searchable and linkable next to the notes that explain them. **The kernel is source-agnostic
and holds no credentials** — *you* fetch with the source's own MCP tools, then write.

- **Register a source once** with `source_register` (`id` like `grafana-prod`, `kind` like
  `grafana`, optional `freshness_hours`). The registry is per-deployment and empty by default.
- **Sync when stale.** `session_start` lists `stale_sources` (and `mirror_status` shows all
  sources' freshness). Fetch the curated subset, then `mirror_upsert { source_id, items }`.
  Idempotent by `(source, native_id)`.
- **Curate — never bulk.** Mirror decision-worthy records only (the canvas where a decision
  landed, the incident that mattered), not whole channels or every event. `content` is a
  compact summary you compose. Per-source recipes live in `docs/mirrors/*.md`.
- **Retire** a stale record with `invalidate` on its node id (external mirrors are yours to
  retire; code symbols are not).
- **Link is the payoff** — draw `documents`/`references`/`relates_to` from a semantic note to a
  mirror record (or between records across sources); a later search surfaces the record via
  graph expansion.

Mirror nodes are still **mirrors**: don't `write`/`update` them by hand — re-sync with
`mirror_upsert`.

```
GOOD: session_start shows grafana-prod stale -> fetch active incidents via the Grafana MCP ->
      mirror_upsert incidents -> write a decision about the fix -> link documents -> the incident.
BAD:  mirror_upsert every message in a Slack channel (bulk dump poisons retrieval).
```

## Tools at a glance

| Tool | Use |
|------|-----|
| `session_start` | First call. session_id + working set. |
| `search` | Find memories. Envelopes only. Search before writing. |
| `get` | Content + edges for specific ids (symbol -> raw `source` too). `outline`/`sections` to take part of a long node. |
| `write` | New node (semantic/episodic). Returns `similar_existing` (with `score`/`confidence`) on a near-dup. |
| `update` | Revise a **semantic** node (episodic write-once; mirror indexer-only). |
| `invalidate` | Soft-delete; pass `superseded_by` when a new node replaces it. |
| `restore` | Undo a wrong retirement — same id, history and edges kept. |
| `link` | Connect two existing nodes with a typed edge (references/documents/…). |
| `checkpoint` | Before ending work: summary + decisions + open threads + touched ids. |
| `code_index` | Index/refresh a repo into symbol mirrors. Incremental; run after changes. |
| `code_lookup` | Structural code lookup by `name`/`file` + defines/calls/imports stubs. |
| `source_register` | Register/update an external mirror source (per-deployment; no creds). |
| `mirror_upsert` | Upsert curated external records into mirror nodes. Idempotent, not bulk. |
| `mirror_status` | List registered sources + freshness (last sync, stale, node count). |
| `consolidate_suggest` | Review what the background sweep queued: distill/merge/link/prune candidates. |
| `consolidate_apply` | Resolve a candidate — `apply` or `reject`. Destructive applies on index nodes deserve care; `restore` exists because one already ate a hand-maintained index. |
| `stats` | Operational snapshot: embedding queue, content totals, storage, daemon health, graph integrity. No content. |

## Notes worth reading

`context_notes` on a response is the server talking to you: a superseded result, a
parked embedding backlog, a duplicate hint. Short and rare — read them.
