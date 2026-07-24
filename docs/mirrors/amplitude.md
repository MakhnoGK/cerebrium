# Mirror recipe: Amplitude

- **kind:** `amplitude` (becomes each mirror node's `origin`)
- **suggested id:** `amplitude`
- **MCP tools:** Amplitude MCP — `get_amplitude_context` (first, for project ids), `get_charts`,
  `get_cohorts`, `get_custom_or_labeled_events`, `search`.
- **suggested `freshness_hours`:** none — the event space is huge; sync on demand.

## Register

```
source_register {
  id: "amplitude",
  kind: "amplitude",
  label: "Amplitude",
  project: "acme",
  recipe: "mirrors/amplitude.md"
}
```

_(No `freshness_hours` on purpose — mirror named artifacts when they matter, not on a clock.)_

## Scope (⚠️ curate hard)

Mirror ONLY named, decision-bearing artifacts: key saved charts, defined cohorts, and the few
custom event definitions the team reasons about. **Never** mirror raw events, the full event
taxonomy, or ad-hoc queries.

## Fetch

1. `get_amplitude_context` for the project id.
2. `get_charts` (saved charts you care about), `get_cohorts`, and
   `get_custom_or_labeled_events` for the key definitions.

## Map each record → `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | chart/cohort/event id |
| `type` | `chart`, `cohort`, or `event_def` |
| `title` | its name |
| `content` | what it tracks and the insight it drove |
| `url` | Amplitude URL |
| `facets` | `{ project, owner, updated_at }` |

## Link

- `documents` from a `decision` note → the chart/cohort that motivated it.
- `relates_to` a Tableau `pulse_metric` measuring the same thing.
