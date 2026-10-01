# dashboard-web

The web dashboard's UI (React, Vite, TanStack Query), served by `apps/dashboard-api`.

- **Overview** — one banner that says what needs attention, and cards for the daemon, the
  store, the embedding queue, generation, consolidation, jobs, the review backlog and graph
  integrity.
- **Activity** — the live action log: history from `/api/activity` with live calls from
  `/api/stream` on top; filter by action or principal, errors only, pause.
- **Consolidation** — the sweep runs and live sweep notices.
- **Review** — pending consolidation candidates with the model's proposal and the members side
  by side, to apply, edit, reject or regenerate; and the runner's writes under a `suggest`
  posture, to keep or undo.

`npm run build:dashboard` builds it into `apps/dashboard-web/dist`;
`npm run dev:dashboard` serves it with `/api` proxied to `localhost:7480`.
