# Mirror recipe: Jira

- **kind:** `jira` (becomes each mirror node's `origin`)
- **suggested id:** `jira`
- **MCP tools:** Atlassian MCP — `searchJiraIssuesUsingJql`, `getJiraIssue`,
  `getJiraIssueRemoteIssueLinks`. Read-only usage here.
- **suggested `freshness_hours`:** `12`

## Register

```
source_register {
  id: "jira",
  kind: "jira",
  label: "Jira",
  project: "acme",
  freshness_hours: 12,
  recipe: "mirrors/jira.md"
}
```

## Scope (keep it narrow)

Mirror only epics and issues in active flow — current sprint, in-progress, or recently
resolved with a decision worth remembering. Never the whole backlog or closed-long-ago tickets.

## Fetch

1. `searchJiraIssuesUsingJql` with a scoped JQL, e.g.
   `project = <KEY> AND (sprint in openSprints() OR statusCategory != Done OR resolved >= -14d)
   ORDER BY updated DESC`.
2. `getJiraIssue` for each hit → summary, description, status, assignee, epic link.

## Map each record → `mirror_upsert` item

| item field | source |
|------------|--------|
| `native_id` | issue key, e.g. `PROJ-1234` |
| `type` | `issue` (or `epic` for epics) |
| `title` | issue summary |
| `content` | 2–5 line distillation: goal, current state, the decision if any |
| `url` | issue browse URL |
| `facets` | `{ status, assignee, priority, labels, epic, sprint }` |

## Link

- A `decision`/`howto` note → `documents` the epic/issue it resolves.
- `relates_to` between a Jira issue and the GitLab `merge_request` that closes it.
