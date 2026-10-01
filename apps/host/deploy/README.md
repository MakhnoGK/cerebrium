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
- This store is the one being written: every machine's agents reach it through the plugin.
  The consolidation sweep runs here on its default postures every 30 minutes.
- Generation is Ollama, run natively on the host for the GPU and reached from the daemon at
  `host.docker.internal:11434`, which is the host's loopback. While it is down the sweep
  records generation failures and detection still runs.
- The `dashboard` service serves the web dashboard on `http://100.92.157.103:7480`, the
  tailnet address only, with no login. It reads the daemon over the socket in
  `cerebrium-data` as the `cerebrium-dashboard` client; see `apps/dashboard-api/README.md`.
- The `runner` service runs agent tasks with `claude -p` from the same image. It reaches the
  daemon over the socket in `cerebrium-data`, writes as `cerebrium-runner` (profile in
  `MEMORY_PRINCIPALS`: writes go to review, 60 an hour), and is authenticated only with the
  subscription token in `secrets/claude_oauth_token`. API-key and cloud-provider variables
  are stripped from the CLI's env, and while the file is empty it claims no job.
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

## The cutover from the Mac's store

Done once, in this order. The Mac's `~/.cerebrium/memory.db` and its launchd agents stay as a
cold rollback and are not used.

1. **Freeze** — on the Mac, stop the local daemon and runner (`node dist/service-cli.js
   uninstall all` from the live checkout keeps the store and removes only the agents), close
   the agent sessions that hold the local `cerebrium` entry, then take the copy:
   `sqlite3 ~/.cerebrium/memory.db ".backup /tmp/cerebrium-final.db"`.
2. **Dump** — on the host, `pg_dump -Fc` the running store into `backups/` (the rehearsal
   copy, kept for rollback).
3. **Recreate** — stop the daemon, rename the database to `cerebrium_rehearsal` (kept for
   rollback, never dropped), create an empty one from `template0`, start the daemon so it
   migrates the empty schema:

   ```bash
   cd ~/cerebrium-host/current
   export CEREBRIUM_TAG=$(basename "$(readlink ~/cerebrium-host/current)") CEREBRIUM_SECRETS=~/cerebrium-host/secrets
   docker compose stop daemon
   docker compose exec -T postgres psql -U cerebrium -d postgres -c 'ALTER DATABASE cerebrium RENAME TO cerebrium_rehearsal'
   docker compose exec -T postgres createdb -U cerebrium -T template0 --locale=C --encoding=UTF8 cerebrium
   docker compose start daemon
   ```

4. **Import** — the copy, filtered to the projects that move, as in *Importing the Mac's
   store* with `--projects 'cerebrium,toonspace*' --global --repo-map /data/repo-map.json
   --verify`. The repo map comes from `npm run code:repo-map` on the Mac.
5. **Host-only rows** — nodes an agent wrote straight to the host before the cutover are
   not in the Mac's copy. Copy them from `cerebrium_rehearsal` by id, with their revisions,
   text, chunks, vectors, edges, code_refs, events and sessions.
6. **Tokens** — issue one per machine (principal `mac`) as in *By hand*; the session's
   `client` names the agent host. The new database has none of the old tokens.
7. **Switch** — on the Mac, `npm run agent:setup -- --kernel tcp://100.92.157.103:7433
   --token-file ~/.cerebrium/host-token --index-repo <each checkout> --apply --verify`.
8. **Check** — in a fresh session, `session_start`, `search` and `code_lookup` answer from
   the host.

## Ollama

Once, on the host: install Ollama (the macOS app, or `brew install ollama` +
`brew services start ollama`), keep its default loopback bind, and pull the model the daemon
asks for:

```bash
ollama pull gemma4:12b-it-qat
```

## The runner's subscription token

The runner draws on the owner's Claude subscription, never on API billing. Turn off extra
usage on claude.ai first, then create a long-lived token on any machine with a browser and
write it into the existing file in place, so the container's mount sees it:

```bash
claude setup-token
# the host's login shell is fish, hence bash -c; paste the token at the prompt
ssh -t hk-obrio@<host> /bin/bash -c "'read -rsp token: t && printf %s \"\$t\" > ~/cerebrium-host/secrets/claude_oauth_token'"
```

The runner reads the file before every claim, so no restart is needed. Check one run with
`docker exec cerebrium-runner-1 node dist/runner.js --once agent.selftest`.

## By hand

Run on the host.

```bash
bash ~/cerebrium-host/releases/<version>/deploy.sh <version>   # redeploy a release
docker compose -p cerebrium ps                                  # state and health
docker compose -p cerebrium logs -f daemon                      # daemon log
docker exec cerebrium-daemon-1 node dist/healthcheck.js         # probe by hand
```

Tokens for the network listener (one per machine) are kept as a sha256 in
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
