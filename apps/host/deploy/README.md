# cerebrium-host deploy

Every merge to `main` that passes CI is released and deployed to the host (the GPU laptop)
by `.github/workflows/release.yml`:

1. **version**: a calver tag `vYYYY.MM.DD.N` (UTC day, N counts that day's releases). A
   re-run for a commit that already has a tag reuses it.
2. **image**: `linux/arm64`, built on an arm64 runner, pushed to
   `ghcr.io/makhnogk/cerebrium:<version>` and `:sha-<commit>`.
3. **release**: a GitHub Release for the tag with generated notes.
4. **deploy** (environment `host`, `main` only): joins the tailnet as an ephemeral `tag:ci`
   node, checks SSH access, uploads this directory to
   `~/cerebrium-host/releases/<version>/` and runs `deploy.sh <version>` there.

## On the host

```
~/cerebrium-host/
  current -> releases/<version>   # the release that last came up healthy
  releases/<version>/             # compose.yml, deploy.sh, README.md
  secrets/                        # pg_password, pg_url — mode 700, created by deploy.sh
  backups/                        # <UTC>-<release>.dump, the 14 newest — mode 700, dumps 600
```

- Docker is OrbStack (`~/.orbstack/bin/docker`); the compose project is `cerebrium`.
- The store is Postgres (`paradedb/paradedb:0.25.10-pg18`: pg_search + pgvector) in the
  `postgres` service, volume `cerebrium-pg`. It publishes no port; only the daemon reaches
  it, over the compose network. `cerebrium-data` (mounted at `/data`, `CEREBRIUM_HOME`)
  keeps the embedding model, the daemon's socket and pidfile, and the SQLite file the
  releases before Postgres used. Both volumes survive every deploy and rollback.
- The first deploy generates the database password into `secrets/` (never printed) and
  the connection URL the daemon reads from `MEMORY_PG_URL_FILE`.
- Until the cutover (plan Phase 7) the Mac's SQLite store is the one being written, and
  this one is a copy: every consolidation posture is `off` here, so the daemon adds nothing
  the source does not have and a re-import converges.
- The daemon applies pending migrations when it opens the store, so there is no separate
  migrate step. Migrations are forward-only: rolling back past one leaves the older code on
  a newer schema.
- The container is healthy when `dist/healthcheck.js` gets a `health` answer on the daemon
  socket with the model loaded and the store answering a query. The first start downloads the embedding model into the
  volume, which the 10-minute start period covers.
- The daemon also serves the kernel on TCP `7433` (`MEMORY_RPC_LISTEN`), published on the
  host's tailnet address only (`CEREBRIUM_RPC_BIND`, default `100.92.157.103`). There is
  no TLS: a connection's first frame must be `initialize {token}`, the token decides the
  principal, and only the call surface plus `initialize`/`health` are served. The job queue
  and `status` stay on the unix socket.
- `deploy.sh` keeps three releases: the current one, the one before it, and one more.
- **Before every deploy** `deploy.sh` dumps the running store (`pg_dump -Fc`) into
  `backups/`. A dump that fails or comes out empty stops the deploy before anything
  changes; no running Postgres (the first deploy) is skipped with a log line.

## Restoring a dump

```bash
cd ~/cerebrium-host/current
export CEREBRIUM_TAG=$(basename "$(readlink ~/cerebrium-host/current)") CEREBRIUM_SECRETS=~/cerebrium-host/secrets
docker compose stop daemon
docker compose exec -T postgres pg_restore --clean --if-exists -U cerebrium -d cerebrium < ~/cerebrium-host/backups/<dump>
docker compose start daemon
```

`--clean --if-exists` drops and recreates every object the dump holds, so the database ends
up exactly as dumped. Rehearse into a scratch database first when in doubt:

```bash
docker compose exec -T postgres createdb -U cerebrium -T template0 --locale=C --encoding=UTF8 scratch
docker compose exec -T postgres pg_restore --no-owner --exit-on-error -U cerebrium -d scratch < ~/cerebrium-host/backups/<dump>
docker compose exec -T postgres dropdb -U cerebrium scratch
```

A scratch database must come from `template0`: the image's `template1` already holds the
`paradedb`, `tiger` and `topology` schemas, so a restore into a copy of it reports "schema
already exists" and carries on.

## Importing the Mac's store

On the Mac, copy the live store without stopping it and send the copy over:

```bash
sqlite3 ~/.cerebrium/memory.db ".backup /tmp/cerebrium-copy.db"
scp /tmp/cerebrium-copy.db hk-obrio@<host>:/tmp/
```

On the host, move it into the daemon's volume and import inside the container, where the
URL is a mounted secret and Postgres needs no published port:

```bash
docker cp /tmp/cerebrium-copy.db cerebrium-daemon-1:/data/import.db
docker exec -u root cerebrium-daemon-1 chown 1000:1000 /data/import.db
docker exec cerebrium-daemon-1 node dist/import-sqlite.js \
  --from /data/import.db --to-file /run/secrets/pg_url --verify
docker exec cerebrium-daemon-1 rm -f /data/import.db /data/import.db-shm /data/import.db-wal
```

`docker cp` keeps the file's owner from the Mac, which the container's `node` user (uid
1000) cannot read, hence the `chown`. Re-running converges; `--verify` compares per-table
counts and content hashes and exits 1 on a mismatch. Rows the host wrote itself (its own
session and sweep runs) are reported as `target_only`, not failed.

## By hand

Run on the host.

```bash
bash ~/cerebrium-host/releases/<version>/deploy.sh <version>   # redeploy a release
docker compose -p cerebrium ps                                  # state and health
docker compose -p cerebrium logs -f daemon                      # daemon log
docker exec cerebrium-daemon-1 node dist/healthcheck.js         # probe by hand
```

Tokens for the network listener (one per machine × agent host) are kept as a sha256 in
Postgres and revoked, never deleted. The value is printed once, so it can go straight to
the client machine without landing on the host's disk:

```bash
# on the client machine
(umask 077 && ssh host /bin/bash -s > ~/.cerebrium/host-token) <<'EOF'
~/.orbstack/bin/docker exec cerebrium-daemon-1 \
  node dist/service-cli.js token issue --principal <principal> --label <machine-agent>
EOF
# on the host
docker exec cerebrium-daemon-1 node dist/service-cli.js token list
docker exec cerebrium-daemon-1 node dist/service-cli.js token revoke <id>
```

A client uses it with `MEMORY_KERNEL_URL=tcp://100.92.157.103:7433` and
`MEMORY_KERNEL_TOKEN_FILE=<that file>`. Open connections drop a revoked token within 30 s.

A manual deploy pulls without credentials, so it works only for an image already on the
host or a public package.

## Required settings

| Where                                    | Name                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| Environment `host` secrets               | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DEPLOY_SSH_KEY` |
| Environment `host` variables             | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`   |
| Tailnet policy                           | `tag:ci` owned by an admin; a grant `tag:ci` → the host on `tcp:22` |
| Host `~/.ssh/authorized_keys`            | the deploy key, `from="100.64.0.0/10",restrict`      |
