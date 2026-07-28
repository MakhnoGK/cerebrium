# External mirror recipes

These recipes are **agent-side documentation, not kernel code**. The Cerebrium kernel is
source-agnostic and credential-free: it never fetches from an external service and knows
nothing about Grafana, Slack, Jira, or any specific tool. A recipe tells *the agent* how to
turn one external source into curated `mirror` nodes using the MCP tools the agent already
has, then write them with `mirror_upsert`.

A deployment with a different toolset simply writes different recipes and registers different
sources — nothing in `src/` changes.

## The loop

1. **Register** the source once (per deployment): `source_register { id, kind, label?, project?, freshness_hours?, recipe? }`.
   - `id` is a local instance, e.g. `grafana-prod`. `kind` becomes each node's `origin`.
2. **Sync** when `session_start` (or `mirror_status`) reports the source stale:
   - Fetch the curated subset with the source's own MCP tools.
   - Map each record to a `mirror_upsert` item (below).
   - `mirror_upsert { source_id, items: [...] }`.
3. **Link** what matters: draw `documents` / `references` / `relates_to` edges from your own
   semantic notes (or between mirror records) with `link`. That note->record link is the payoff
   and survives re-sync.
4. **Retire** a record that no longer matters: `invalidate` its node id.

## Curation is the rule — never bulk

Mirror only **decision-worthy** records: the canvas where a decision landed, the incident that
mattered, the dashboard the team watches, the epic in flight. Bulk-dumping a Slack channel or
every Amplitude event poisons retrieval and floods the embedding queue, which defeats the whole
token-economy design. Each recipe names its scope; keep it narrow.

## `mirror_upsert` item shape

| field | required | notes |
|-------|----------|-------|
| `native_id` | yes | the source's own id (issue key, message ts, chart id). Upsert key with `source_id`. |
| `type` | yes | open vocab, e.g. `incident`, `thread`, `chart`. No migration needed for a new type. |
| `title` | yes | short human title. |
| `content` | yes | a **compact markdown summary you compose** — the searchable body. Not a raw dump. |
| `url` | no | deep link back to the record. |
| `project` | no | overrides the source's default project scope for this record. |
| `facets` | no | opaque JSON metadata (status, author, labels…), returned by `get`. |

Idempotent by `(source_id, native_id)`: re-syncing identical content is a no-op; changed
content adds a revision.

## Recipes in this directory

- `_template.md` — copy this to start a new recipe.
- Complete recipes (register block + scope + fetch + map + link), one per source:
  `grafana-prod`, `gitlab`, `jira`, `confluence`, `notion`, `sentry`, `slack`, `testrail`,
  `tableau`, `amplitude`.

Two of these (`slack`, `amplitude`) carry no `freshness_hours` on purpose — they're
high-volume, so you sync a specific artifact when it's worth capturing rather than on a clock.
