# Mirror recipe: Confluence

- **kind:** `confluence` (becomes each mirror node's `origin`)
- **suggested id:** `confluence`
- **MCP tools:** Atlassian MCP — `searchConfluenceUsingCql`, `getConfluencePage`,
  `getPagesInConfluenceSpace`.
- **suggested `freshness_hours`:** `72`

## Register

```
source_register {
  id: "confluence",
  kind: "confluence",
  label: "Confluence",
  project: "acme",
  freshness_hours: 72,
  recipe: "mirrors/confluence.md"
}
```

## Scope (keep it narrow)

Mirror canonical reference pages only — architecture docs, runbooks, decision records, team
charters. Not personal drafts, meeting notes, or every page in a space.

## Fetch

1. `searchConfluenceUsingCql`, e.g. `space = <KEY> AND type = page AND lastmodified >= now("-90d")`,
   or a maintained allow-list of page ids.
2. `getConfluencePage` for each → title + body; summarize the body (do not store it whole).

## Map each record → `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | page id |
| `type` | `page` |
| `title` | page title |
| `content` | a compact summary of what the page establishes — not the full body |
| `url` | page web URL |
| `facets` | `{ space, author, version, updated_at }` |

## Link

- `documents` from a semantic note that relies on the page (a decision citing a runbook).
- `relates_to` a Jira `epic` the page specs.
