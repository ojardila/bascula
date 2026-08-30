# Báscula API

Multi-tenant HTTP service. Go 1.26, chi, pgx, goose, Postgres 17 + PostGIS.

```bash
make up        # Postgres+PostGIS on :5433, waits until it answers
make migrate   # apply the migrations (its own step, before any rollout)
make test      # the suite, against that same Postgres
make run       # serve on :8080
```

`GET /health` answers without touching the database.

## What is built

Sprints 1 and 2: auth and open signup, workers, plots with their crops,
activities with dated rates, work records, the `/v1/pickups` facade, the
super-admin console, and the whole money domain — `pending`, `balance`,
`settle`, `void`, `reverse`, payments, advances, deductions and adjustments.

Sprint 3 adds the three modules the owner wrote and nobody had built:

- **Productos e inventario** (RSP-018 … RSP-025). Product categories and
  storage units as per-farm catalogues, warehouses, products, and the
  movements existencias are derived from.
- **Ventas** (RSP-026 … RSP-029), each writing its outgoing stock movement in
  the same transaction, and each void giving the stock back.
- **Gastos** (RSP-030 … RSP-033), charged to an activity or to a plot/crop and
  never to a person.
- **File uploads**, so a receipt and an employee photo have somewhere to live.

Sprint 4 closes the hole the owner pointed at: the console knew how to
administer a farm and had no way to say how the harvest was going. Every bit of
that analysis lived in the phone and none of it on the server. Six endpoints
under `/v1/reports` are the port — the weekly list, the week's worker-by-day
and worker-by-crop grids, the per-crop statistics, the comparative performance
index, the five review rules, and the harvest curve. The SQL is
`internal/store/reports.go`; the reading of the curve is `internal/domain`,
the Go twin of `packages/shared/src/harvest.ts`.

### A report never returns a zero that means "I do not know"

This one is in capitals in the sprint brief because it had just cost a week:
every harvest record read as $0 in the console, because a null amount was
rendered as a figure. In a report the mistake is worse, not better — a week
where nobody picked really is 0 kg, so an unknown printed as a zero is
indistinguishable from the truth.

So `kg`, `valueCents`, `index`, `kgPerDay`, `kgPerHa`, `trend` and `peak` are
all nullable on the wire, and every null arrives with a count or a reason
beside it: `recordsNotInKg` says how many weighings were left out of a kilo
figure because their work unit has no `kgFactor`, `reason` says why a picker
has no index, and the crop grid's null column carries `unattributed` saying
whether the work named no crop or named several. `valueIsEstimate` keeps what
the farm OWES from looking like what it has paid.

### The two traps the phone found first, and what Postgres needed

The extra-zero rule was algebraically unable to fire, because its reference
included the very weighing it was judging: `w >= 10*avg` reduces to
`n+1 >= n+10`. The crew rule was a self-join, quadratic inside each plot-day,
that took 10.8 seconds on 18,000 weighings. Both fixes are carried over rather
than re-derived, and `reports_perf_test.go` runs the old shape beside the new
one over a real season and fails if they disagree — 27 ms against 17.5 s here.

Four things Postgres needed that SQLite did not: `local_day` is a stored column
and not a `date(col,'localtime')` call, so the redundant second bound every
mobile rule carries to become sargable is gone; `'localtime'` is the farm's
zone on a phone and UTC on a server, so every window is computed from
`farms.timezone`; the duplicate rule's `b.id < a.id` tie-break is chronological
on AUTOINCREMENT integers and meaningless on our UUIDs, so it is
`(created_at, id)`; and a weighing here is a quantity in a work unit rather
than one `weight` column, so a unit with no `kgFactor` has no kilos at all.

### Existencias are derived, like the balance

There is no `stock` column and there will not be one. Every quantity this API
reports is a `SUM` over `stock_moves`, computed on the way out, and
`stock_moves` is append-only with the same trigger and the same `REVOKE` the
ledger has. A stored total is a total that some day disagrees with the facts
underneath it, and when it does nothing can say which of the two is lying. A
mistake is corrected with its opposite at `/v1/stock/moves/{id}/reverse`.

### A gasto is not a deuda

The use case document uses one word for two things. RSP-030 calls the cost of a
spraying a *gasto*; RSP-007 calls what an employee owes the farm a *deuda*. On
a form they look identical. They are not the same thing, and if they were wired
together, recording the cost of the spraying would take money out of somebody's
wages.

So `expenses` has no `employee_id` column, nothing under `/v1/expenses` reaches
the ledger, and a debt goes through `POST /v1/deductions` and nowhere else.
`TestAnExpenseIsNotADebt` stands between the two.

### The server does not print

RSP-025 says the system prints the identification stickers. It generates the
batch and returns its id; `/v1/label-batches/{id}` hands over the labels, and
whatever holds the paper asks for them. A request that blocked on a printer
would fail a harvest because the paper ran out.

### Uploads, and where the bytes go

Two steps in the shape a presigned URL takes: `POST /v1/uploads` reserves a row
and answers where to `PUT` the bytes. **There is no object storage in this
environment**, so `internal/blob` writes to a directory (`UPLOAD_DIR`, required
outside development) and the upload URL points back at this service. The seam
is real — swapping in S3/R2 is one file in `internal/blob` and a different
`uploadUrl`, and no handler changes — and so are its limits: a disk on one box
does not replicate, and two API processes need a shared volume.

**The 5 MB of RSP-004 is enforced on the bytes that arrive**, not on the size
the client declared when it asked for the URL — that number is accepted, used
for an early courtesy refusal, and never stored. The server reads one byte past
the limit so that "exactly at the limit" is told apart from "over it", writes
the size IT counted, sniffs the media type from the content rather than the
header, and a `CHECK` on `attachments` refuses anything over the limit whatever
wrote it. A pending attachment cannot be hung on a sale or an employee: a
trigger refuses it.

## The five decisions that shaped the schema

1. **Signup is open.** `POST /v1/signup` is public. The farm is active the
   moment it exists — nobody at the platform approves it — but the owner cannot
   open a session until the address is verified. Being the most exposed surface
   in the system, it carries a per-IP rate limit that lives in Postgres (so it
   survives a restart) and mandatory verification.

   It takes an address that has **no** account. One that already exists is
   refused with 409 `EMAIL_TAKEN` on the address alone, and the password in the
   body is never looked at — it used to be, and a wrong one answering 409 while
   the right one answered 201 made the registration form a place to test
   guesses without authenticating. Adding another farm to an account that
   exists is `POST /v1/farms`, behind that account's own session, and the
   farms-per-account cap lives there now.

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
   varieties, work units, product categories and storage units are per-farm
   rows reached through `/v1/catalogs/*`, idempotent by
   `(farm_id, lower(name))`. Enums are only for what the code branches on:
   `ledger_kind`, `pay_method`, `farm_role`, `settlement_status`, `pay_scheme`,
   `time_unit`, `stock_reason`.

6. **Every write is idempotent by `(farm_id, id)`, the money included.** The
   contract has always said so; until sprint 3 the ledger did not do it, and a
   payment resent after a timeout hit the primary key and came back as a 500.
   On a farm with two bars of signal that is not an edge case, and the person
   retrying has already handed over the cash. Now every money write takes a
   client-generated id, a resend answers 200 with the row that is already
   there, and the same id carrying a different worker or amount is 409
   `IDEMPOTENCY_KEY_REUSED` — never a silent success and never a second row.
   `POST /v1/settlements/{id}/void` and `/v1/ledger/{id}/reverse` take the id
   of the reversal they write, which is what a retry is recognised by; without
   one, a repeat is still a conflict, because guessing "it was probably a
   retry" is guessing with somebody's wages.

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
- **`idempotency_test.go`** — the same money write sent twice leaves one row
  and answers the same both times, for settle, void, reverse, payment, advance,
  deduction and adjustment; the same id with a different amount is refused.
  Including the case where a full payment resent would otherwise come back as
  `AMOUNT_EXCEEDS_BALANCE`, a business rule standing in for a dropped
  connection.
- **`sprint3_test.go`** — existencias derived and movements append-only; a sale
  and its stock movement written together and voided together; an expense that
  does not move a worker's balance and an `expenses` table with no column that
  could; the 5 MB enforced on the bytes that arrive; and the credible zero
  closed on every new endpoint that sums or lists.
- **`reports_test.go`** — `performance.test.ts` and `review.test.ts` from the
  phone, case for case, through HTTP: the index scores 1 for somebody matching
  their mates and 2 for somebody doubling them (1.5 was the bug where the
  picker sat inside their own benchmark), the average of daily ratios comes out
  at 1.35 where a ratio of sums would not, and each of the five review rules is
  shown firing on exactly the weighings it used to. Plus the two properties the
  phone never needed: both week grids reconcile by rows and by columns and
  against each other and against the weekly list, and no figure is ever a zero
  standing in for an unknown.
- **`reports_perf_test.go`** — a season of 18,000 weighings over 40 pickers, 6
  crops and 150 days, with every report timed against a two-second ceiling, and
  the retired quadratic crew rule run beside its replacement to show they still
  answer the same thing.
- **`golden_test.go`** — replays `packages/shared/golden/cases/*.json` through
  the Go domain against real Postgres. Nine cases, the exact cents the phone
  produces.

## Left for the next sprint

User management (`/v1/users`), the public repository of activities and products
that RSP-010 and RSP-018 assume ("trae del repositorio publico en internet"),
everything in the registry schema, and object storage for uploads — the
interface is here, the bucket is not.

Also deliberately unbuilt: RSP-022 … RSP-024 do not exist in
`docs/casos-de-uso.md`, which jumps from RSP-021 to RSP-025. The warehouse
endpoints under `/v1/warehouses` are what the DDL implies they were, but nobody
has written the use cases, so nothing was invented beyond a name and a row.
