# Bascula API.
#
#   make up       start Postgres+PostGIS and wait until it answers
#   make migrate  apply the migrations (a separate step, before any rollout)
#   make prune    sweep the sync feed (docs/sincronizacion.md 3.4) — a cron job
#   make test     run the suite against that same Postgres
#   make run      serve on :8080
#   make dev      serve on :8099 with the signup cap lifted, for the e2e suite
#
# ADMIN_DATABASE_URL owns the schema. DATABASE_URL is the application role,
# which has no BYPASSRLS — that is the whole point of having two.
#
# `run` and `dev` say APP_ENV=development out loud, and they have to. The
# server treats an unset APP_ENV as production and refuses to boot without a
# JWT_SECRET, because the alternative — the old default — was a deployment
# that inherited the development posture from a line nobody wrote. A Makefile
# is the right place for that word: it is checked in, it is read, and it is
# not what a container runs.

SHELL := /bin/bash

PGPORT ?= 5433
PORT_DEV ?= 8099
ADMIN_DATABASE_URL ?= postgres://postgres:postgres@localhost:$(PGPORT)/bascula?sslmode=disable
DATABASE_URL       ?= postgres://bascula_api:bascula_api_dev@localhost:$(PGPORT)/bascula?sslmode=disable

export ADMIN_DATABASE_URL
export DATABASE_URL

.PHONY: up down migrate prune test test-verbose run dev build fmt vet tidy psql logs clean

up:
	docker compose up -d
	@echo "waiting for postgres on :$(PGPORT)..."
	@for i in $$(seq 1 60); do \
		docker compose exec -T postgres pg_isready -U postgres -d bascula >/dev/null 2>&1 && { echo "ready"; exit 0; }; \
		sleep 1; \
	done; \
	echo "postgres did not come up"; docker compose logs --tail=40 postgres; exit 1

down:
	docker compose down

migrate:
	go run ./cmd/api -migrate

# The retention sweep. It runs on ADMIN_DATABASE_URL, like migrations and for
# the same reason: sync_log is append-only and DELETE is revoked from the
# application role, so the process that serves requests cannot prune the feed.
# Schedule it nightly. It is idempotent and safe to run twice.
prune:
	go run ./cmd/api -prune

# TEST_ADMIN_DATABASE_URL points the suite at a live Postgres. Without it the
# database-backed tests skip loudly instead of pretending to pass.
test:
	TEST_ADMIN_DATABASE_URL="$(ADMIN_DATABASE_URL)" go test ./...

test-verbose:
	TEST_ADMIN_DATABASE_URL="$(ADMIN_DATABASE_URL)" go test -v ./...

run:
	APP_ENV=development go run ./cmd/api

# The same server, set up so the end-to-end suite in apps/web can run more than
# once an hour. Signups are capped at 5 per IP and 5 per address by default,
# which is right in production and useless on a laptop where a test run spends
# four of them and a developer re-registering their own address spends the rest.
dev:
	APP_ENV=development PORT=$(PORT_DEV) SIGNUPS_PER_IP_PER_HOUR=1000 SIGNUPS_PER_EMAIL_PER_HOUR=1000 go run ./cmd/api

build:
	go build -o bin/api ./cmd/api

fmt:
	gofmt -w ./cmd ./internal ./migrations

vet:
	go vet ./...

tidy:
	go mod tidy

psql:
	docker compose exec postgres psql -U postgres -d bascula

logs:
	docker compose logs -f postgres

clean:
	docker compose down -v
	rm -rf bin
