# Mirror recipe: Notion

- **kind:** `notion` (becomes each mirror node's `origin`)
- **suggested id:** `notion`
- **MCP tools:** Notion MCP — `notion-search`, `notion-fetch`, `notion-query-data-sources`,
  `notion-query-database-view`.
- **suggested `freshness_hours`:** `72`

## Register

```
source_register {
  id: "notion",
  kind: "notion",
  label: "Notion",
  project: "acme",
  freshness_hours: 72,
  recipe: "mirrors/notion.md"
}
```

## Scope (keep it narrow)

Mirror durable reference pages and specific database rows that carry decisions — specs, project
hubs, RFCs. Never entire databases or scratch/journal pages.

## Fetch

1. `notion-search` for the pages/hubs you care about, or `notion-query-data-sources` /
   `notion-query-database-view` against a specific database with a filter.
2. `notion-fetch` for each page → summarize; keep it compact.

## Map each record → `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | Notion page/row id |
| `type` | `page` (or `db_row` for a database row) |
| `title` | page/row title |
| `content` | a compact summary of the spec/decision — not the full page |
| `url` | Notion URL |
| `facets` | `{ database, status, owner, updated_at }` |

## Link

- `documents` from a decision/howto note to the spec it describes.
- `relates_to` a Jira `epic` or GitLab `merge_request` that implements the spec.
