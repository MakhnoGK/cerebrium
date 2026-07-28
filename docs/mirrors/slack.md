# Mirror recipe: Slack

- **kind:** `slack` (becomes each mirror node's `origin`)
- **suggested id:** `slack`
- **MCP tools:** Slack MCP — `slack_search_public` / `slack_search_public_and_private`,
  `slack_read_thread`, `slack_read_canvas`, `slack_read_channel`.
- **suggested `freshness_hours`:** none — Slack is high-volume; sync on demand, not on a clock.

## Register

```
source_register {
  id: "slack",
  kind: "slack",
  label: "Slack",
  project: "acme",
  recipe: "mirrors/slack.md"
}
```

_(No `freshness_hours` on purpose — you decide when a thread/canvas is worth capturing.)_

## Scope (⚠️ curate hard)

Mirror ONLY:
- **Canvases** that capture a decision, plan, or runbook.
- **Specific threads** where a decision was made or a root cause was found.

**Never** mirror channels wholesale, standups, or routine chatter — a bulk dump poisons
retrieval and floods the embedding queue.

## Fetch

1. `slack_search_public` (or `_and_private`) to find the specific thread/canvas by keyword.
2. `slack_read_thread` for the decision thread, or `slack_read_canvas` for a canvas.

## Map each record -> `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | canvas id, or `channel_id/thread_ts` |
| `type` | `canvas` or `thread` |
| `title` | a short title you give it (Slack threads have none) |
| `content` | the **decision / outcome distilled** — not the raw transcript |
| `url` | Slack permalink |
| `facets` | `{ channel, participants, decided_at }` |

## Link

- `documents` from a `decision` note -> the thread/canvas it came from (the payoff: a decision
  in memory that points at the Slack conversation where it was made).
