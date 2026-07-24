# Mirror recipe: <source name>

- **kind:** `<kind>` (becomes each mirror node's `origin`)
- **suggested id:** `<instance-id>`
- **MCP tools used:** `<which MCP server / tools the agent calls to fetch>`
- **suggested `freshness_hours`:** `<n>`

## Register

```
source_register {
  id: "<instance-id>",
  kind: "<kind>",
  label: "<human label>",
  project: "<default project or omit>",
  freshness_hours: <n>,
  recipe: "mirrors/<this-file>.md"
}
```

## Scope (what to mirror — keep it narrow)

<Describe the curated subset. Name what to INCLUDE and what to deliberately leave out.
Mirror decision-worthy records only; never bulk-export.>

## Fetch

<Step-by-step: which MCP tool calls fetch the scoped records, with any filters.>

## Map each record → `mirror_upsert` item

| item field | source field |
|------------|--------------|
| `native_id` | `<source id>` |
| `type` | `<record type>` |
| `title` | `<source title>` |
| `content` | `<how to compose the compact summary>` |
| `url` | `<deep link>` |
| `facets` | `<structured metadata to keep>` |

## Link

<Which edges are worth drawing from notes or between records, e.g. a `decision` that
`documents` this record, or a `relates_to` between a Sentry issue and a GitLab MR.>
