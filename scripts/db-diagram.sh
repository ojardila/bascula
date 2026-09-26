#!/usr/bin/env bash
#
# Regenerate docs/database.md from the migrations.
#
# Starts a throwaway Postgres+PostGIS container (the same image as
# docker-compose.yml), applies every migration in services/api/migrations,
# introspects the schema with services/api/cmd/dbdiagram and removes the
# container again. Your local database (make up, port 5433) is not touched.
#
#   scripts/db-diagram.sh            # or: make db-diagram
#
# CI runs the generator against its own Postgres service and fails when the
# committed docs/database.md differs, so run this whenever you add or change a
# migration and commit the result with it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${DB_DIAGRAM_IMAGE:-imresamu/postgis:17-3.5}"
NAME="bascula-db-diagram-$$"

command -v docker >/dev/null || { echo "db-diagram: docker is required" >&2; exit 1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# A fresh random password per run: the container lives for seconds and only
# listens on 127.0.0.1, but nothing here should look like a shared credential.
PGPASS="$(od -An -N16 -tx1 /dev/urandom | tr -d " \n")"

docker run -d --rm --name "$NAME" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=bascula \
  -e TZ=UTC -e PGTZ=UTC \
  -p 127.0.0.1::5432 "$IMAGE" >/dev/null

PORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed -E 's/.*:([0-9]+)$/\1/')"

echo "db-diagram: waiting for scratch postgres on :$PORT..."
ready=""
for _ in $(seq 1 90); do
  # pg_isready answers during the entrypoint's temporary init server too, so
  # also require a real query over TCP.
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d bascula >/dev/null 2>&1 &&
     docker exec "$NAME" psql -h 127.0.0.1 -U postgres -d bascula -tAc 'select 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ -n "$ready" ] || { echo "db-diagram: postgres did not come up" >&2; docker logs --tail=40 "$NAME" >&2; exit 1; }

cd "$ROOT/services/api"
ADMIN_DATABASE_URL="postgres://postgres:$PGPASS@127.0.0.1:$PORT/bascula?sslmode=disable" \
  go run ./cmd/dbdiagram -migrate -out "$ROOT/docs/database.md"
