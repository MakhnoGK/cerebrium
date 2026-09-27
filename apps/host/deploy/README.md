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
```

- Docker is OrbStack (`~/.orbstack/bin/docker`); the compose project is `cerebrium`.
- The store lives in the named volume `cerebrium-data`, mounted at `/data`
  (`CEREBRIUM_HOME`). It survives every deploy and rollback.
- The daemon applies pending migrations when it opens the store, so there is no separate
  migrate step. Migrations are forward-only: rolling back past one leaves the older code on
  a newer schema.
- The container is healthy when `dist/healthcheck.js` gets a `health` answer on the daemon
  socket with the model loaded. The first start downloads the embedding model into the
  volume, which the 10-minute start period covers.
- `deploy.sh` keeps three releases: the current one, the one before it, and one more.

## By hand

Run on the host.

```bash
bash ~/cerebrium-host/releases/<version>/deploy.sh <version>   # redeploy a release
docker compose -p cerebrium ps                                  # state and health
docker compose -p cerebrium logs -f daemon                      # daemon log
docker exec cerebrium-daemon-1 node dist/healthcheck.js         # probe by hand
```

A manual deploy pulls without credentials, so it works only for an image already on the
host or a public package.

## Required settings

| Where                                    | Name                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| Environment `host` secrets               | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DEPLOY_SSH_KEY` |
| Environment `host` variables             | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`   |
| Tailnet policy                           | `tag:ci` owned by an admin; a grant `tag:ci` → the host on `tcp:22` |
| Host `~/.ssh/authorized_keys`            | the deploy key, `from="100.64.0.0/10",restrict`      |
