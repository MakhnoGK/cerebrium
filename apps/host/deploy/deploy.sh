#!/usr/bin/env bash
# Deploys one release on the host: secrets → pull → dump the store → up → wait for healthy
# → roll back on failure.
#
#   deploy.sh <version> [registry-user]
#
# A registry token on stdin is used for the pull and never stored.
# Runs under the macOS system bash (3.2), so no bash-4 syntax.
set -euo pipefail

ROOT="${CEREBRIUM_HOST_ROOT:-$HOME/cerebrium-host}"
IMAGE="ghcr.io/makhnogk/cerebrium"
KEEP=3
KEEP_DUMPS=14
WAIT_SECONDS="${CEREBRIUM_WAIT_SECONDS:-900}"
SECRETS="$ROOT/secrets"
BACKUPS="$ROOT/backups"

export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

release_dir() {
  echo "$ROOT/releases/$1"
}

compose() {
  local version="$1"
  shift
  CEREBRIUM_TAG="$version" CEREBRIUM_SECRETS="$SECRETS" \
    docker compose -f "$(release_dir "$version")/compose.yml" "$@"
}

# Created once and never printed. The directory is the protection: the files themselves are
# world-readable so the unprivileged user inside each container can read its mount.
ensure_secrets() {
  mkdir -p "$SECRETS"
  chmod 700 "$SECRETS"

  if [[ ! -s "$SECRETS/pg_password" ]]; then
    (umask 022 && openssl rand -hex 24 | tr -d '\n' >"$SECRETS/pg_password")
    echo "generated a Postgres password in $SECRETS"
  fi

  # Filled by hand with a `claude setup-token` token; the runner claims nothing while empty.
  if [[ ! -e "$SECRETS/claude_oauth_token" ]]; then
    (umask 022 && : >"$SECRETS/claude_oauth_token")
  fi

  local password
  password="$(cat "$SECRETS/pg_password")"
  (umask 022 && printf 'postgres://cerebrium:%s@postgres:5432/cerebrium' "$password" >"$SECRETS/pg_url")
}

# A custom-format dump of the running store, taken before anything changes. No Postgres
# running (the first deploy, or a previous release on SQLite) is not an error; a dump that
# fails or comes out empty is, and stops the deploy.
backup() {
  local previous="$1" id="" state="" name partial

  if [[ -n "$previous" ]]; then
    id="$(compose "$previous" ps -q postgres 2>/dev/null || true)"
  fi

  if [[ -n "$id" ]]; then
    state="$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null || true)"
  fi

  if [[ "$state" != "running" ]]; then
    echo "no running Postgres to back up; skipping the dump"
    return 0
  fi

  mkdir -p "$BACKUPS"
  chmod 700 "$BACKUPS"
  name="$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-$previous.dump"
  partial="$name.partial"

  if ! (umask 077 && compose "$previous" exec -T postgres pg_dump -Fc -U cerebrium cerebrium >"$partial"); then
    rm -f "$partial"
    echo "pg_dump failed; not deploying" >&2
    return 1
  fi

  if [[ ! -s "$partial" ]]; then
    rm -f "$partial"
    echo "pg_dump produced nothing; not deploying" >&2
    return 1
  fi

  mv "$partial" "$name"
  echo "backed up the store to $name"

  local kept=0 dump
  for dump in $(ls -1t "$BACKUPS"/*.dump 2>/dev/null); do
    kept=$((kept + 1))
    if ((kept > KEEP_DUMPS)); then rm -f "$dump"; fi
  done
}

pull() {
  local token=""

  if [[ ! -t 0 ]]; then
    token="$(cat)"
  fi

  if [[ -z "$token" ]]; then
    docker image inspect "$IMAGE:$VERSION" >/dev/null 2>&1 || docker pull "$IMAGE:$VERSION"
    return
  fi

  # The macOS keychain is locked in an SSH session, and the docker CLI picks it whenever a
  # docker-credential-osxkeychain is on PATH, even with no credsStore in the config. So:
  # a throwaway config, a PATH without the helper, and the engine named directly because
  # the throwaway config has no docker context.
  local config engine bin
  bin="$(command -v docker)"
  engine="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
  config="$(mktemp -d)"
  echo '{}' >"$config/config.json"

  local status=0
  printf '%s' "$token" |
    env PATH=/usr/bin:/bin DOCKER_HOST="$engine" DOCKER_CONFIG="$config" \
      "$bin" login ghcr.io -u "$REGISTRY_USER" --password-stdin >/dev/null &&
    env PATH=/usr/bin:/bin DOCKER_HOST="$engine" DOCKER_CONFIG="$config" \
      "$bin" pull "$IMAGE:$VERSION" ||
    status=$?

  rm -rf "$config"
  return "$status"
}

# `compose up --wait` exits 0 when its timeout passes with the service still starting, so
# health is read from the container instead.
wait_healthy() {
  local version="$1" deadline=$((SECONDS + WAIT_SECONDS)) id state=""

  id="$(compose "$version" ps -q daemon)"

  if [[ -z "$id" ]]; then
    echo "no daemon container for $version" >&2
    return 1
  fi

  while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || echo gone)"

    case "$state" in
      "running healthy") return 0 ;;
      "running unhealthy" | exited* | dead* | gone)
        echo "daemon is $state" >&2
        return 1
        ;;
    esac

    sleep 5
  done

  echo "daemon not healthy after ${WAIT_SECONDS}s (last: ${state:-unknown})" >&2
  return 1
}

up() {
  compose "$1" up -d && wait_healthy "$1"
}

prune() {
  local current="$1" previous="$2" kept=0 name

  for name in $(ls -1t "$ROOT/releases"); do
    if [[ "$name" == "$current" || "$name" == "$previous" ]]; then
      continue
    fi

    kept=$((kept + 1))

    # The current release and the rollback target take two of the KEEP slots.
    if ((kept > KEEP - 2)); then
      rm -rf "$(release_dir "$name")"
      docker image rm "$IMAGE:$name" >/dev/null 2>&1 || true
    fi
  done
}

main() {
  VERSION="${1:?usage: deploy.sh <version> [registry-user]}"
  REGISTRY_USER="${2:-token}"

  if [[ ! -f "$(release_dir "$VERSION")/compose.yml" ]]; then
    echo "no release files at $(release_dir "$VERSION")" >&2
    exit 1
  fi

  previous=""
  if [[ -L "$ROOT/current" ]]; then
    previous="$(basename "$(readlink "$ROOT/current")")"
  fi

  echo "deploying $VERSION (previous: ${previous:-none})"
  ensure_secrets
  pull
  backup "$previous"

  if up "$VERSION"; then
    ln -sfn "releases/$VERSION" "$ROOT/current"
    prune "$VERSION" "$previous"
    compose "$VERSION" ps
    echo "deployed $VERSION"
    exit 0
  fi

  echo "release $VERSION did not become healthy" >&2
  compose "$VERSION" logs --tail 80 daemon >&2 || true

  if [[ -n "$previous" && "$previous" != "$VERSION" ]]; then
    echo "rolling back to $previous" >&2
    up "$previous" || echo "rollback to $previous failed too" >&2
  else
    compose "$VERSION" down || true
  fi

  exit 1
}

# Sourced by the tests for its functions; run, it deploys.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
