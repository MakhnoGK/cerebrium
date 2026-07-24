# Mirror recipe: TestRail

- **kind:** `testrail` (becomes each mirror node's `origin`)
- **suggested id:** `testrail`
- **MCP tools:** TestRail MCP (authenticate first via its `authenticate` /
  `complete_authentication` tools, then its case/run/result read tools).
- **suggested `freshness_hours`:** `48`

## Register

```
source_register {
  id: "testrail",
  kind: "testrail",
  label: "TestRail",
  project: "acme",
  freshness_hours: 48,
  recipe: "mirrors/testrail.md"
}
```

## Scope (keep it narrow)

Mirror the test cases/suites for the areas under active work, and notable runs — a release
regression run, or a suite under investigation. Not the entire case library or every run.

## Fetch

1. Authenticate the TestRail MCP if needed.
2. List the suite/section for the area in flight → the relevant cases; and the recent runs of
   interest → their result summaries.

## Map each record → `mirror_upsert` item

**Test case:**

| item field | source |
|------------|--------|
| `native_id` | case id (e.g. `C1234`) |
| `type` | `test_case` |
| `title` | case title |
| `content` | what it verifies + preconditions/steps summary |
| `url` | case URL |
| `facets` | `{ suite, section, priority, type }` |

**Test run:** `type: "test_run"`, `native_id: R<id>`, content = pass/fail summary + notable
failures, facets `{ suite, passed, failed, blocked, milestone }`.

## Link

- `relates_to` from a `merge_request` mirror or `documents` from a bug `decision` → the case
  that covers it.
