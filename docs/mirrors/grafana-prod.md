# Mirror recipe: Grafana (prod)

- **kind:** `grafana` (becomes each mirror node's `origin`)
- **suggested id:** `grafana-prod`
- **MCP tools used:** the Grafana MCP server (`list_incidents`, `get_incident`,
  `search_dashboards`, `get_dashboard_summary`, …). Read-only.
- **suggested `freshness_hours`:** `24`

## Register

```
source_register {
  id: "grafana-prod",
  kind: "grafana",
  label: "Grafana (prod)",
  project: "acme",
  freshness_hours: 24,
  recipe: "mirrors/grafana-prod.md"
}
```

## Scope (what to mirror — keep it narrow)

Mirror only:
- **Incidents** that are active, or resolved within the last ~30 days (they carry the
  post-mortem signal worth remembering).
- A **short, hand-picked list of key dashboards** the team actually watches (checkout, auth,
  payments overview) — NOT every dashboard, and never individual panels.

Do **not** mirror: raw metrics/log lines, alert firings, every dashboard, or anything you'd
only look at once. Those belong in Grafana, not in memory.

## Fetch

1. `list_incidents` filtered to active + recently-resolved -> for each, `get_incident` for the
   summary, severity, affected service, and timeline.
2. `search_dashboards` (or a maintained allow-list of UIDs) -> `get_dashboard_summary` for each
   key dashboard.

## Map each record -> `mirror_upsert` item

**Incident:**

| item field | source |
|------------|--------|
| `native_id` | incident id (e.g. `INC-42`) |
| `type` | `incident` |
| `title` | incident title |
| `content` | 2–5 line markdown: what broke, blast radius, resolution, root cause if known |
| `url` | incident permalink |
| `facets` | `{ severity, service, status, opened_at, resolved_at }` |

**Dashboard:**

| item field | source |
|------------|--------|
| `native_id` | dashboard UID |
| `type` | `dashboard` |
| `title` | dashboard title |
| `content` | what the dashboard shows and when to reach for it |
| `url` | dashboard permalink |
| `facets` | `{ folder, tags }` |

## Link

- From a `decision`/`howto` note about a fix -> `documents` the `incident` it addressed.
- Between a Grafana `incident` and a Sentry `issue` or GitLab `merge_request` for the same
  event -> `relates_to`.
