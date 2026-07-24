# Mirror recipe: Tableau

- **kind:** `tableau` (becomes each mirror node's `origin`)
- **suggested id:** `tableau`
- **MCP tools:** Tableau MCP — `list-workbooks`, `get-workbook`, `list-views`, `get-view`,
  `list-all-pulse-metric-definitions`, `list-pulse-metrics-from-metric-definition-id`.
- **suggested `freshness_hours`:** `72`

## Register

```
source_register {
  id: "tableau",
  kind: "tableau",
  label: "Tableau",
  project: "acme",
  freshness_hours: 72,
  recipe: "mirrors/tableau.md"
}
```

## Scope (keep it narrow)

Mirror the handful of workbooks/views and Pulse metrics the team actually relies on for
decisions. Never the whole site or every view.

## Fetch

1. `list-workbooks` / `list-views` (or a maintained allow-list) → `get-workbook` / `get-view`
   for the ones that matter.
2. `list-all-pulse-metric-definitions` → the key metric definitions.

## Map each record → `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | workbook/view/metric id (LUID) |
| `type` | `workbook`, `view`, or `pulse_metric` |
| `title` | its name |
| `content` | what it measures and when to reach for it |
| `url` | Tableau content URL |
| `facets` | `{ project, owner, updated_at }` |

## Link

- `documents` from a `decision` note that cited a metric/view → the record.
- `relates_to` an Amplitude `chart` measuring the same thing.
