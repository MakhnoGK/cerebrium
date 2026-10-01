# dashboard-api

The web dashboard's backend: a NestJS app that talks to the daemon as the
`cerebrium-dashboard` client over its unix socket, and serves the built `dashboard-web` app
at `/`.

- `GET /api/status` — daemon health, processes, store and queue stats, generation and
  Ollama reachability, recent jobs and the review backlog. The operator config is never
  passed on.
- `GET /api/activity?limit=&before=` — the audit log, newest first, and the latest sweep
  runs (`recent_activity`).
- `GET /api/consolidation/candidates?kind=&cursor=` — pending candidates, 20 a page, each with
  its member nodes; `POST …/:id/decision` (`apply` or `reject`, optional `override` and, for
  merge, `collapse`) and `POST …/:id/retry` (drop the proposal so the model writes it again).
- `GET /api/reviews` and `POST /api/reviews/decision` — writes that landed under a `suggest`
  posture (the runner's), kept or undone.
- `GET /api/graph?invalidated=1&symbols=1` — the whole authored graph for drawing it
  (`graph_snapshot`): live nodes and edges, the retired nodes a live edge still points at,
  and on request every retired node and the code symbols notes cite.
- `GET /api/stream` — server-sent events: every audited call as it is recorded
  (`activity`), each finished sweep (`consolidation`) and a fresh status every 5 s
  (`status`).

The wire types are in `packages/contracts/src/dashboard.ts`.

| Variable                                         | Default                             |
| ------------------------------------------------ | ----------------------------------- |
| `MEMORY_DAEMON_SOCKET`                           | `$CEREBRIUM_HOME/daemon.sock`       |
| `MEMORY_KERNEL_URL` + `MEMORY_KERNEL_TOKEN_FILE` | a host's TCP listener instead       |
| `DASHBOARD_PORT` / `DASHBOARD_HOST`              | `7480` / `0.0.0.0`                  |
| `DASHBOARD_OLLAMA_URL`                           | `http://host.docker.internal:11434` |

Against the host from a Mac: `npm run build`, then
`MEMORY_KERNEL_URL=tcp://100.92.157.103:7433 MEMORY_KERNEL_TOKEN_FILE=~/.cerebrium/host-token node dist/dashboard.js`.
