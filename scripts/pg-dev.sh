#!/bin/sh
# A throwaway Postgres for `npm run test:pg`: ParadeDB (pg_search + pgvector) on port 55432,
# byte-order collation as the store requires. Data lives on tmpfs and nothing is durable, so
# WAL is kept small: every test creates and drops a database.
set -eu

NAME=cerebrium-pg
PORT=${CEREBRIUM_PG_PORT:-55432}
RUNTIME=$(command -v podman || command -v docker || true)

if [ -z "$RUNTIME" ]; then
  echo "pg-dev: neither podman nor docker is on PATH" >&2
  exit 1
fi

case "${1:-}" in
  up)
    if ! "$RUNTIME" container exists "$NAME" 2>/dev/null && ! "$RUNTIME" inspect "$NAME" >/dev/null 2>&1; then
      "$RUNTIME" run -d --name "$NAME" -p "$PORT:5432" \
        -e POSTGRES_USER=cerebrium -e POSTGRES_PASSWORD=cerebrium -e POSTGRES_DB=cerebrium \
        -e POSTGRES_INITDB_ARGS="--locale=C --encoding=UTF8" \
        --tmpfs /var/lib/postgresql:rw,size=4g \
        docker.io/paradedb/paradedb:0.25.10-pg18 \
        -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
        -c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=256MB >/dev/null
    else
      "$RUNTIME" start "$NAME" >/dev/null
    fi
    echo "export CEREBRIUM_TEST_PG_URL=postgres://cerebrium:cerebrium@localhost:$PORT/postgres"
    ;;
  down)
    "$RUNTIME" rm -f "$NAME" >/dev/null
    ;;
  *)
    echo "usage: pg-dev.sh up|down" >&2
    exit 2
    ;;
esac
