# Mirror recipe: Sentry

- **kind:** `sentry` (becomes each mirror node's `origin`)
- **suggested id:** `sentry`
- **MCP tools:** Sentry MCP (self-hosted `sentry.example.com`) — `search_issues`,
  `get_sentry_resource`, `search_events`, `analyze_issue_with_seer`.
- **suggested `freshness_hours`:** `24`

## Register

```
source_register {
  id: "sentry",
  kind: "sentry",
  label: "Sentry (sentry.example.com)",
  project: "acme",
  freshness_hours: 24,
  recipe: "mirrors/sentry.md"
}
```

## Scope (keep it narrow)

Mirror high-signal issues only — recurring / high-frequency errors, regressions, or anything
with a root cause or a Seer analysis worth remembering. Never every event or one-off exception.

## Fetch

1. `search_issues` with a scoped query, e.g. `is:unresolved timesSeen:>100` or
   `is:regressed`, most-frequent first.
2. For the ones that matter, `analyze_issue_with_seer` and/or `get_sentry_resource` for the
   root-cause detail; `search_events` for the impact window.

## Map each record → `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | Sentry short id / issue id (e.g. `PROJ-9K`) |
| `type` | `issue` |
| `title` | issue title (culprit) |
| `content` | error summary + root cause / Seer takeaways + fix if known |
| `url` | issue permalink |
| `facets` | `{ level, status, project, count, users_affected, last_seen }` |

## Link

- `relates_to` between a Sentry `issue` and the Grafana `incident` / GitLab `merge_request` for
  the same event.
- `documents` from a `decision` note that captures the fix → the issue.
