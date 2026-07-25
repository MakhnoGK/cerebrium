# Mirror recipe: GitLab

- **kind:** `gitlab` (becomes each mirror node's `origin`)
- **suggested id:** `gitlab`
- **tooling:** the `glab` CLI, authenticated against self-hosted `git.example.com`
  (`glab -R <group>/<project> mr list`, `glab api …`). Not an MCP server — shell out.
- **suggested `freshness_hours`:** `12`

## Register

```
source_register {
  id: "gitlab",
  kind: "gitlab",
  label: "GitLab (git.example.com)",
  project: "acme",
  freshness_hours: 12,
  recipe: "mirrors/gitlab.md"
}
```

## Scope (keep it narrow)

Mirror only:
- **Merge requests** recently merged or actively in review for the repos you're working in.
- **Issues** that carry a decision or a spec in the thread (not routine tickets).

Do **not** mirror: every MR/issue in the group, pipeline logs, comment-by-comment history.

## Fetch

1. `glab -R <group>/<project> mr list --state merged --per-page 20` and `... --state opened`;
   `glab -R <group>/<project> mr view <iid>` for the description + decisions.
2. `glab -R <group>/<project> issue list --state opened` -> `issue view <iid>` for the ones with
   real decision content.

## Map each record -> `mirror_upsert` item

**Merge request:**

| item field | source |
|------------|--------|
| `native_id` | `<group>/<project>!<iid>` (globally unique) |
| `type` | `merge_request` |
| `title` | MR title |
| `content` | what changed and why, distilled from the description + key discussion |
| `url` | MR web URL |
| `facets` | `{ state, author, labels, milestone, source_branch }` |

**Issue:** same shape, `type: "issue"`, `native_id: <group>/<project>#<iid>`,
facets `{ state, author, labels, milestone }`.

## Link

- A `decision` note -> `documents` the MR that implemented it.
- `relates_to` between an MR and the Sentry `issue` / Grafana `incident` it fixed.
