# Bascula API.
#
#   make up       start Postgres+PostGIS and wait until it answers
#   make migrate  apply the migrations (a separate step, before any rollout)
#   make test     run the suite against that same Postgres
#   make run      serve on :8080
#
# ADMIN_DATABASE_URL owns the schema. DATABASE_URL is the application role,
# which has no BYPASSRLS — that is the whole point of having two.

SHELL := /bin/bash

PGPORT ?= 5433
ADMIN_DATABASE_URL ?= postgres://postgres:postgres@localhost:$(PGPORT)/bascula?sslmode=disable
DATABASE_URL       ?= postgres://bascula_api:bascula_api_dev@localhost:$(PGPORT)/bascula?sslmode=disable

export ADMIN_DATABASE_URL
export DATABASE_URL

.PHONY: up down migrate test test-verbose run build fmt vet tidy psql logs clean

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

# TEST_ADMIN_DATABASE_URL points the suite at a live Postgres. Without it the
# database-backed tests skip loudly instead of pretending to pass.
test:
	TEST_ADMIN_DATABASE_URL="$(ADMIN_DATABASE_URL)" go test ./...

test-verbose:
	TEST_ADMIN_DATABASE_URL="$(ADMIN_DATABASE_URL)" go test -v ./...

run:
	go run ./cmd/api

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
