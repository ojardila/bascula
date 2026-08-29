# Báscula API

Multi-tenant HTTP service. Go 1.26, chi, pgx, goose, Postgres 17 + PostGIS.

```bash
make up        # Postgres+PostGIS on :5433, waits until it answers
make migrate   # apply the migrations (its own step, before any rollout)
make test      # the suite, against that same Postgres
make run       # serve on :8080
```

`GET /health` answers without touching the database.

## What sprint 1 built

Auth and open signup, workers, plots with their crops, activities with dated
rates, work records, and the whole money domain: `pending`, `balance`,
`settle`, `void`, `reverse`, payments, advances, deductions and adjustments.

## The five decisions that shaped the schema

1. **Signup is open.** `POST /v1/signup` is public. The farm is active the
   moment it exists — nobody at the platform approves it — but the owner cannot
   open a session until the address is verified. Being the most exposed surface
   in the system, it carries a per-IP rate limit that lives in Postgres (so it
   survives a restart), a cap on farms per email address, and mandatory
   verification.

2. **Activity rates have a history.** `activity_pay_*` does not hold one loose
   price; it holds periods with a `valid_from`. A period runs until the next one
   begins, so two overlapping prices cannot be expressed and the primary key
   `(activity_id, valid_from)` is the index that forbids trying. A work record
   freezes the rate in force on its day, and **a record whose price is derived
   from a date must be a single day** — enforced by `work_record_rate_shape`,
   not by convention.

3. **The registry schema is created and empty.** Nothing is built inside it this
   sprint. Migration `00007` says what will live there and, more importantly,
   what never will.

4. **The web records work from day one.** Until sync exists, a work record
   entered on the web does not exist for the phone and vice versa. Pay from one
   side only.

5. **Catalogues are tables, not enums.** Activity categories, crop types,
   varieties and work units are per-farm rows reached through
   `/v1/catalogs/*`, idempotent by `(farm_id, lower(name))`. Enums are only for
   what the code branches on: `ledger_kind`, `pay_method`, `farm_role`,
   `settlement_status`, `pay_scheme`, `time_unit`.

## Isolation

Two database roles, and that is the point. `ADMIN_DATABASE_URL` owns the schema;
`DATABASE_URL` is `bascula_api`, which inherits `bascula_app` and has **no
BYPASSRLS**. The process that serves requests cannot alter the tables whose
policies protect it.

Every request runs in a transaction that begins with
`SET LOCAL app.farm_id`, and the middleware reads it back through
`current_farm()` before any handler runs. If it did not take, the request is
**500 TENANT_NOT_SET** rather than a 200 with an empty list: RLS answers a
tenant-less query with zero rows and no error, and an empty worker list is
indistinguishable from a brand new farm.

Every table with a `farm_id` has RLS enabled, forced, and a policy — the ones
whose rule is not simply "same farm" are written by hand in `00008`, the rest
are generated in a loop.

## Naming

The two design documents name the same things differently. The entity a farmer
calls a *labor* is `work_records` everywhere in code and on
the wire — `arquitectura-api.md` called it `/v1/tasks` in one section and
`work_records` in another, `modelo-datos.md` called it `labors`. The Spanish
interface still says "labor", which is the owner's word.

| Wire (`arquitectura-api.md`) | Database (`modelo-datos.md`) |
|---|---|
| `/v1/workers` | `employees` |
| `/v1/work-records` | `work_records` |
| `amountCents`, `rateCents` | `amount_minor`, `price_minor` |

Money is `bigint` in the currency's minor unit, and the columns say `_minor` and
not `_cents` because the COP has no real cents. The JSON keeps `Cents` because
that is what the phone and the contract already say.

## Tests

`make test` needs a live Postgres and says so when it does not have one; nothing
skips silently. See the package comment in `internal/apitest/main_test.go` for
why this suite uses the compose Postgres rather than testcontainers.

The load-bearing ones:

- **`isolation_test.go`** — two seeded farms, and farm A cannot reach farm B
  through a list, through a known id, through the balances, or through a direct
  query with the handlers bypassed. It also asserts the tenant-less request is
  loud.
- **`contract_test.go`** — walks the built router and fails if a route is
  mounted without an entry in the permission table, or declares an action with
  no rule. Then it asserts a live 403 for the weigher on every money route, and
  that the weigher still keeps what he needs: recording weighings, reading
  workers without their documents, activities without their rates, and only the
  work records he recorded.
- **`money_test.go`** — the anti double-pay lock, including the case where the
  query layer is bypassed and only the partial unique index can stop it.
- **`golden_test.go`** — replays `packages/shared/golden/cases/*.json` through
  the Go domain against real Postgres. Nine cases, the exact cents the phone
  produces.

## Left for the next sprint

Plot boundaries over HTTP (the column, the GiST index and the `ST_IsValid`
constraint are already there; there is no endpoint that writes one), media
uploads, employee notes over HTTP, user management, the `/v1/pickups`
compatibility facade, super-admin farm administration, and everything in the
registry schema.
