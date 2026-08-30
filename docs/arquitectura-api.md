# Báscula — API and auth design (revision 2, scope RSP-001…033)

## 0. Invariants inherited from the mobile app (still intact)

`int64` cents; append-only ledger (cancelled with a `reverso`, never edited);
week = **the ISO Monday's date** (`2026-08-24`) — the `"2026-W33"` comment at
`db.ts:447` is obsolete, `WEEK_OF` already yields the Monday; business dates in
the farm's zone (`farms.timezone`, required); `UUIDv7` ids generated on the
client.

**The finding that orders the whole revision: the ledger is already general
enough and does not change.** `devengo / pago / anticipo / deduccion / ajuste /
reverso` covers a coffee picking, a day's work and a pruning contract equally
well. What gets generalised is **what feeds** the ledger.

---

## 1. Tension A — pickups or work records? **Generalise. One path.**

Keeping two paths duplicates the one thing that cannot be duplicated: the
double-payment lock. Today `ux_items_pickup_live` guarantees that a weighing
belongs to exactly one live settlement. With two payable tables you would need
two locks, and no way for one settlement to take them both in a single
transaction — an employee who picks coffee **and** does a day's work in the same
week needs **one** settlement, not two.

**Model:**

```
activities   (per-farm catalogue)
  id, name, category(siembra|mantenimiento|cosecha),
  pay_mode(contract|time_unit|work_unit),
  time_unit(jornal|semanal|quincenal|mensual|custom) | work_unit(kg|arroba|canasta|…),
  default_rate_cents, rate_source(weekly_price|fixed), status

work_records (labores — RSP: the record that somebody performed an activity)
  id, worker_id, activity_id, plot_ids[], crop_ids[],
  date_from, date_to, quantity, rate_cents NULL, note, created_by
```

A weighing is a `work_record` with `pay_mode='work_unit'`, `unit='kg'`,
`date_from = date_to`, `quantity = weight`. **Nothing more.**

`settlement_items.pickupId` becomes `payable_id` (+ `payable_kind`, today always
`'work_record'`, reserved for future payables such as bonuses). The partial
index is kept identical: `UNIQUE(payable_id) WHERE voided_at IS NULL`.

**The fine point that has to be decided today, not later:** when the price is
frozen.

| `pay_mode` | Price | Moment |
|---|---|---|
| `work_unit` + `rate_source='weekly_price'` | `costForWeek(monday)` | **at settlement** (current behaviour, preserved) |
| `work_unit` + `fixed`, `contract`, `time_unit` | the record's own `rate_cents` | **at write time**, frozen |

A mandatory corollary: a `work_record` with `rate_source='weekly_price'` **must
be single-day** (`date_from = date_to`). A day's work running Tuesday to Tuesday
does not have "a" week, and deriving a weekly price over a range is the class of
ambiguity that ends in a miscalculated payment. Ranges are legitimate only with
a frozen price.

**Migration cost, concretely:**
- **Mobile: zero in delivery 1.** `/v1/pickups` survives as a thin facade over
  `work_records` (POST creates against the seed activity "Recolección"; GET
  filters `pay_mode='work_unit'`). The phone is not touched.
- **Server: 3–5 days of one dev.** The ported SQL (`PENDING_SQL`, `INDEX_SQL`,
  `WEEK_*_SQL`, the anomaly rules) is not rewritten: it gains
  `WHERE a.pay_mode = 'work_unit'`. The comparative index and the anomaly rules
  **only make sense per unit of work** — comparing day-rate jobs by productivity
  means nothing — so that filter is correct, not a bodge.
- **Mobile, delivery 2:** ~2 weeks to move to `/v1/work-records` and gain work
  records. `/v1/pickups` is deprecated but not removed while there is still an
  old phone on a farm, and there always is.

---

## 2. Tension C — GIS: **PostGIS from the start.**

A polygon in `jsonb` is decoration: it does not validate, does not calculate and
does not answer anything. The moment somebody asks "how many hectares does this
plot really have?" or "does this plot overlap the neighbour's?", every query has
to be rewritten *and* the data backfilled. PostGIS is an extension available on
RDS, Cloud SQL and Supabase; adopting it costs one line of migration.

```sql
plots (
  id uuid, farm_id uuid, name text, department text, municipality text,
  area_ha numeric(10,4),                    -- what the owner declares
  boundary geography(Polygon, 4326),        -- what he drew on the map
  status text CHECK (status IN ('active','inactive'))
)
```

**Three** functions get used and no more: `ST_IsValid` (reject self-intersecting
polygons, `400 INVALID_GEOMETRY`), `ST_Area(boundary)/10000` (calculated
hectares) and `ST_Intersects` (warn about overlaps between plots). Both the
declared `area_ha` and `computedAreaHa` are returned: they always disagree, and
hiding one of them decides for the owner which one is lying. At the HTTP
boundary everything travels as **GeoJSON**, so the web and the mobile app never
see PostGIS. We are not building a GIS product.

---

## 3. Tension B — Cross-tenant history (RSP-004, RSP-009)

**This is not one more endpoint. It is a different product, with legal risk of
its own, and that has to be said before anyone writes the code.**

Search by *cédula* + "safety alerts" + several farms querying = a **de facto
labour blacklist**. In Colombia that falls under Law 1581 of 2012 (habeas data):
processing personal data without authorisation, without a declared purpose,
without a right of rectification. Free text saying "this man is trouble" is
distributed defamation — unverifiable, uncontestable — and it sinks a person
across a whole region without their ever knowing.

**Design: a separate service, `registry`, its own schema, its own credentials,
no access to the farm schema. Never one more table inside the tenant.**

```
POST /registry/v1/lookups
  {documentType, documentNumber, purpose:"hiring"}
  -> { verified: true,
       farmsWorked: 3,
       employmentSpans:[{from:"2024-01",to:"2024-06"}],   -- months, not days
       disputes: 0,
       consentOnFile: true }
GET  /registry/v1/workers/{docHash}/lookups     -- who looked me up (for the worker)
POST /registry/v1/consents                      -- explicit opt-in, revocable
POST /registry/v1/disputes                      -- right of reply
```

**What is shared:** that the *cédula* exists and is verified; **how many** farms
and in which months; whether there are open disputes. **What is never shared:**
farm names, balances, debts, advances, amounts, kilos, productivity, free-text
notes, photos, phone, address. Not even to the super-admin.

Hard rules: (1) **with no recorded consent from the worker, `lookup` returns
`403 NO_CONSENT`** and nothing else; (2) every lookup leaves a trace with
`farm_id`, user and `purpose`, and **the worker can read that trace** — that is
the half of RSP-009 genuinely worth building; (3) participation is **opt-in per
farm**, and opting out does not erase other farms' history but does cut off the
contribution.

**Explicit recommendation to the owner: the free-text "safety alerts" are not
built in delivery 1, and probably never in that form.** If he insists, the only
defensible version is: a structured fact from a closed catalogue, attributed to
an identifiable farm, notified to the worker, disputable, and expiring
automatically at 24 months. Without those five properties it is a weapon.
Delivery 1 builds the **lookup log** (cheap, useful, no risk) and leaves the
rest behind a flag that is off.

---

## 4. Go structure (no substantive changes, two more packages)

`chi` + `pgx/v5` + `sqlc` + `goose`, for the same reason as before: the domain
is accounting and `BALANCE_SQL`/`PENDING_SQL` have to be ported *literally*;
GORM over a ledger is ruled out. Flat layout under `internal/`: `httpapi`,
`domain`, `store`, `auth`, `tenant`, **`+ media`** (uploads), **`+ registry`**
(the cross-tenant service, compilable as a separate binary from day 1 even
though for now it deploys alongside). Tests with `testcontainers` and real
Postgres + PostGIS.

**Photos (employee 5 MB, sale receipt): never in Postgres.** Object storage with
upload via a pre-signed URL.
```
POST /v1/media/uploads {kind:"worker_photo"|"sale_receipt", contentType, sizeBytes}
  -> {mediaId, uploadUrl, expiresIn}   ; the client uploads directly, then references mediaId
```
The 5 MB limit is validated on the server at confirmation time, not only in the
pre-sign.

---

## 5. REST contract. Base `/v1`, tenant in the token. `M`=mobile, `W`=web.

**Auth and farm signup** — there is a clash with the previous revision here: the
document asks for **self-registration** in its unnumbered section and the
earlier design gave signup to the super-admin alone. It is settled with both
doors, and a new farm becomes active once its email is verified (see
`docs/decisiones.md`):
```
POST /v1/signup {farm:{name,timezone}, owner:{email,name,password}}   public, rate-limited
POST /v1/auth/login · /auth/refresh · /auth/logout · GET /v1/me        M W
GET|POST /v1/admin/farms · PATCH /v1/admin/farms/{id} {status}         W  (super-admin)
```

**Plots and crops** (M reads, W writes)
```
GET|POST /v1/plots · GET|PATCH /v1/plots/{id}            soft delete: PATCH {status:"inactive"}
PUT      /v1/plots/{id}/boundary   {geojson}             400 INVALID_GEOMETRY
GET|POST /v1/plots/{id}/crops      {cropTypeId,varietyId,plantedAt,areaHa}
GET|POST /v1/catalogs/crop-types · /v1/catalogs/varieties · /v1/catalogs/units
```
The catalogues answer the "if it does not exist, a button to add it": `POST`
with `{name}` is idempotent on `(farm_id, lower(name))` and returns `200` with
the existing row. Autocomplete never duplicates.

**Employees** (M W)
```
GET|POST /v1/workers · GET|PATCH /v1/workers/{id} · DELETE (soft delete)
GET /v1/workers/{id}/profile   -> balance + latest movements + work records + notes
GET|POST /v1/workers/{id}/notes                       notes, append-only
```

**Activities and work records** (M W)
```
GET|POST|PATCH /v1/activities?category=            prices: owner only
GET|POST /v1/work-records?workerId&plotId&from&to
PATCH|DELETE /v1/work-records/{id}                 409 WORK_RECORD_SETTLED
GET|POST|PATCH|DELETE /v1/pickups                  legacy facade over work_records   M
```

**Settlements and money** — unchanged except that `pickupIds` becomes
`payableIds`:
```
POST /v1/settlements/preview · POST /v1/settlements {payableIds[]} · GET /v1/settlements/{id}
POST /v1/settlements/{id}/void
POST /v1/payments · /advances · /deductions · /adjustments · /ledger/{id}/reverse · /payroll/undo
GET  /v1/balances · /v1/workers/{id}/balance · /v1/workers/{id}/ledger · /v1/pending · /v1/farm/totals
```

**Inventory, sales, expenses** (W; the mobile app only reads stock)
```
GET|POST /v1/products · /v1/warehouses · /v1/product-categories
GET      /v1/stock?warehouseId&cropId&plotId          derived stock, never written
POST     /v1/stock-movements {productId,warehouseId,qty,unit,reason,plotId,cropId}
POST     /v1/labels/print     {productId,qty}  -> PDF/ZPL of stickers
GET|POST /v1/sales    {productId,qty,customer,amountCents,receiptMediaId}
GET|POST /v1/expenses {amountCents,scope:"activity"|"plot_crop",activityId|plotId,cropId,note}
```
**Stock is derived from movements**, the same way the balance is derived from
the ledger. Same discipline, same reason: a stored total is a total that will
lie one day.

**Configuration and users**: `GET|PUT /v1/config`,
`GET|PUT /v1/prices/weeks/{monday}`, `GET|POST|PATCH /v1/users` (owner).

---

## 6. Authorisation — the weigher, now with more surface to deny

15-minute access JWT (claims `sub, farm_id, role, device_id, jti`) + an opaque
60-day refresh token in Postgres, with rotation and reuse detection: the phone
goes days without a signal and a borrowed phone has to be killable from the web.
**The tenant travels in the token, never in the path** — a `farmId` in the path
invites somebody to trust it. Middleware:
`Auth → Tenant (SET LOCAL app.farm_id, RLS active on every table) → Require(action)`,
with the permissions in **a Go table**, not in per-handler `if`s.

The new scope multiplies what the weigher must not see. His complete allowlist
is: `POST /v1/work-records` (only `work_unit` activities), `GET` of his own
records (RLS on `created_by = sub`), and a minimal read of workers
(`id,name,lastName,tag` — no document, no phone, no photo), plots and crops.
**403 in middleware** for everything else, the new modules included:
`/activities` with prices, `/sales`, `/expenses`, `/stock*`,
`/workers/{id}/profile`, `/workers/{id}/notes`, `/registry/*` and `/users`.
`GET /v1/config` reaches him without `costPerUnitCents`; `GET /v1/activities`
without `default_rate_cents`.

A contract test walks the route table and asserts 403 for the weigher on every
money, people or registry route; **a new route with no entry in the table breaks
the build**. With nine modules, that stops being hygiene and becomes the only
defence that scales.

---

## 7. `packages/shared` and errors

`shared` holds only what costs money if it diverges: enums (`LedgerKind`,
`PayMethod`, `Role`, **`PayMode`**, **`ActivityCategory`**, **`StockReason`**),
the money DTOs, and four pure rules (`mondayOf`, `toCents/fromCents`, signs by
`kind`, `amountCents(qty, rate)`). **`openapi.yaml` is the source of truth**:
`oapi-codegen` for Go, `openapi-typescript` for web and mobile, regenerated in
CI with a red build if the diff is not committed. The pure rules are written
twice (~40 lines) and tied together by a shared JSON fixture that both suites
run — rounding and ISO weeks is exactly where two languages diverge in silence.

Errors: `{"error":{"code","message","details"}}`; the client branches on `code`,
the translation lives in the client. Business conflicts are **409 with a code of
their own, and they are part of the contract**: `WORK_RECORD_SETTLED`,
`PAYABLE_ALREADY_CLAIMED` (with the full `details.winningSettlement` so the
phone can re-derive), `SETTLEMENT_ALREADY_VOID`, `ALREADY_REVERSED`,
`NOTHING_TO_SETTLE`, `FARM_SUSPENDED`, and new ones: `INSUFFICIENT_STOCK`,
`INVALID_GEOMETRY`, `PLOT_HAS_ACTIVE_CROPS` (soft delete blocked), `NO_CONSENT`
(registry). Every write accepts a client-supplied `id` and is idempotent on
`(farm_id, id)`: retrying after a timeout returns `200` with the existing
resource, not `409`.

---

## 8. What I would NOT build now

- **Offline sync.** Same as before: it gets built against rules that are already
  settled. Delivery 1 = mobile online.
- **Rewriting the mobile app onto work records.** The `/v1/pickups` facade
  exists precisely so that does not block anything.
- **The cross-tenant "safety alerts".** See §3. The lookup log gets built; the
  rest stays behind a flag that is off, and a conversation with the owner.
- **Inventory with costing (FIFO/average), batch traceability, sales
  reconciliation.** Delivery 1: stock and movements. Costing is a project of its
  own.
- **Printing stickers from the server with configurable templates.** A
  fixed-size PDF. The configurable template arrives when somebody complains
  about the size.
- **Performance and anomaly reports on the server.** They already work and are
  tested on the phone; porting that delicate SQL now doubles the risk for a web
  app that does not exist yet.
- **GraphQL, gRPC, microservices, CQRS, configurable permissions, 2FA, SSO.**
  One binary (two with `registry`), one Postgres, four hard-coded roles.
- **A super-admin UI.** Self-registration makes it nearly unnecessary.

**First sprint:** dev A → migrations + PostGIS + RLS + auth/signup + workers +
plots/crops + catalogues. Dev B → `domain`: generalise `payable`, port
`PENDING_SQL`/`BALANCE_SQL`, `settle/void/reverse`, activities and work records,
with tests against real Postgres. They meet at `openapi.yaml`, which is written
on day one before any handler. `registry`, sales, expenses and inventory land in
sprint 2.


---

# Báscula — Delivery 2: generalisation, new modules and cross services

## 0. The migration nobody has costed yet

Before generalising work records there is an earlier one, cheaper to do now than
in six months: **tension 2 of the document**. Today `crops` mixes plot and crop
(`name, type, variety, dimension`) and `pickups.cropId` points there — that is,
a coffee weighing today hangs off something that is *the plot*, not *the crop*.
RSP-001 separates them: a plot has an area, a location and a polygon, and
**several** crops with a type and a variety.

The split is 1:1 and lossless, and that is exactly why it has to happen now:

```
crops(id, name, type, variety, dimension)
  → plots(id, name, area_ha := dimension, department, municipality, boundary NULL)
  + plot_crops(id, plot_id, crop_type_id := catalogue(type), variety_id := catalogue(variety))
  ; pickups.cropId → tasks.plot_crop_id   (deterministic mapping, one row for one)
```

While it stays 1:1, the mobile compatibility facade can lie perfectly:
`POST /v1/pickups {cropId}` resolves to the generated `plot_crop`. The moment a
farm registers a second crop on a plot, it stops being 1:1 and the facade can no
longer invent which one it was. **Window: until the web allows adding crops.**
That is the real deadline for the mobile migration, not a preference.

---

## 1. Generalisation: `/v1/tasks` rules, `/v1/pickups` survives as a shortcut

**Recommendation: one path. `tasks` (labores) is the payable entity; picking by
the kilo is a `task` on an activity with `pay_mode='work_unit'`, `unit='kg'`,
`date_from = date_to`.**

The decisive argument is not elegance, it is **RSP-008**: the payment screen the
owner describes shows *one* list of work records, *one* of debts and *one*
"Total a pagar". Two payable tables living side by side force two
double-payment locks (`ux_items_pickup_live` duplicated) and make it impossible
for an employee who picked coffee **and** felled by the day in the same week to
receive **one** settlement. The owner's own document demands a single payable
flow.

```
activities   id, farm_id, name, category_id, pay_mode(contract|time_unit|work_unit),
             unit_id NULL, time_unit(jornal|semanal|quincenal|mensual|custom) NULL,
             custom_qty NULL, custom_period(dia|mes|ano) NULL,
             default_rate_cents, rate_source(fixed|weekly_price), status
tasks        id, farm_id, activity_id, worker_id, date_from, date_to,
             quantity numeric, rate_cents NULL, rate_source, note, status, created_by
task_plots   (task_id, plot_id)          -- RSP-015: plots, plural, required
task_crops   (task_id, plot_crop_id)     -- RSP-015: crops, plural, required
```

`settlement_items.pickup_id` becomes `payable_id` → `tasks.id`, with an
identical partial index. **The ledger does not change by a single line:**
`devengo` describes a picking, a day's work and a contract equally well. That is
the reassuring finding of the whole delivery.

**Price, and the rule that has to be closed today.**
`amount_cents = round(quantity × rate_cents)` — the same rule the mobile app
already uses (`Math.round(weight * costPerUnitCents)`), now valid for all three
modes: `contract` (quantity=1), `time_unit` (quantity = number of days),
`work_unit` (quantity = kg/arrobas/baskets). But two freezing moments coexist:

| | price | frozen |
|---|---|---|
| `work_unit` + `weekly_price` | `costForWeek(monday)` | **at settlement** (current behaviour, untouched) |
| everything else | the work record's own `rate_cents`, defaulting to the activity's (RSP-015) | **at write time** |

And from that, a mandatory constraint: **`rate_source='weekly_price'` requires
`date_from = date_to`**. RSP-015 allows date ranges; a day's work running
Tuesday to Tuesday has no single Monday and deriving a weekly price over a range
is exactly the ambiguity that ends in a miscalculated payment. Ranges yes, but
with a frozen price. A `CHECK` on the table, not a convention.

**Migration cost:**
- **Mobile in production: zero in this delivery.** `/v1/pickups` stays as a thin
  facade (POST creates a `task` on the seed activity "Recolección por kilos"
  with a `plot_crop`; GET filters `pay_mode='work_unit'`). Nobody's phone gets
  touched mid-harvest.
- **Server: ~1 week of one dev**, half of which is the `crops → plots +
  plot_crops` split. The ported SQL (`PENDING_SQL`, `BALANCE_SQL`, `INDEX_SQL`,
  `WEEK_*`, the anomaly rules) **is not rewritten**: it gains
  `JOIN activities a ... WHERE a.pay_mode='work_unit'`. The comparative index
  and anomaly detection only make sense per unit of work — comparing
  productivity between day-rate jobs means nothing — so that filter is the right
  semantics, not a bodge.
- **Mobile, next delivery: ~2 weeks** to move to `/v1/tasks` and gain work
  records in the field. `/v1/pickups` is deprecated and not removed while there
  is still an old phone on a farm; there always is.

---

## 2. New endpoints

Minimum role: `wei` (weigher or above) · `adm` (administrator or above) · `own`
(owner only). `M`=mobile, `W`=web, `R`=read.

**Catalogues** — these answer the "with the option to add it if it does not
exist" of RSP-001/011/019. `POST` idempotent on `(farm_id, lower(name))`:
returns `200` with the existing row, never duplicates.
```
GET|POST /v1/catalogs/{crop-types|varieties|activity-categories|work-units|
                       time-units|product-categories|storage-units|customers}   W adm
```

**Plots** (RSP-001…003) — crops nested, because the form is a single one
```
GET  /v1/plots?status=active                                            M W R  wei
POST /v1/plots  {id,name,areaHa,department,municipality,
                 boundary:GeoJSON|null,
                 crops:[{id,cropTypeId,varietyId}]}                     W      adm
GET  /v1/plots/{id}                        -> includes crops[] and computedAreaHa  wei
PATCH /v1/plots/{id}                       identical body, replaces crops[]        adm
DELETE /v1/plots/{id}                      -> status='inactive'                    adm
POST|DELETE /v1/plots/{id}/crops[/{cropId}]                             W      adm
```
`areaHa` (declared) and `computedAreaHa` (`ST_Area` of the polygon) are **both**
returned. They always disagree; choosing which to show is the owner's decision,
not the server's.

**Employees** (RSP-004…008) — the RSP-007 profile in one call
```
GET  /v1/workers/{id}/profile   -> worker + balance + tasks[] + ledger[] + notes[]   W adm
GET|POST /v1/workers/{id}/notes  {text}      append-only, visibility defaults to private   adm
GET  /v1/workers/{id}/payables  -> {tasks:[{activity,date,plots,amountCents}],
                                    debts:[...], totalCents}    ← the RSP-008 screen    adm
GET  /v1/payments/{id}/receipt  -> PDF                          ← the "recibo de pago"  adm
POST /v1/media/uploads {kind:"worker_photo"|"sale_receipt",contentType,sizeBytes}
                                 -> {mediaId,uploadUrl}   5 MB validated on confirm     adm
```
Partial and full payment in RSP-008 **need no new endpoints**: they are
`POST /v1/payments` with `amountCents < balance` or `= balance`. The "less than
the current balance" validation happens on the server against the derived
balance, with `409 AMOUNT_EXCEEDS_BALANCE`. No `isFullPayment` flag that can
fall out of sync.

**Activities** (RSP-010…013)
```
GET  /v1/activities?category=&q=        grouped by category                      M W R  wei*
POST|PATCH /v1/activities                                                        W      adm
PATCH /v1/activities/{id} {status:"inactive"}                                    W      adm
PUT  /v1/activities/{id}/rate {rateCents}                                        W      own
```
`wei*`: the weigher gets the list **without** `defaultRateCents` or
`rateSource`. A different projection, the same route.

**Work records** (RSP-014…017)
```
GET  /v1/tasks?workerId&plotId&activityId&from&to&status                M W R  wei (own only)
POST /v1/tasks {id,activityId,workerId,quantity,rateCents?,
                dateFrom,dateTo,plotIds[],plotCropIds[],note}           M W    wei (work_unit only)
PATCH|DELETE /v1/tasks/{id}      409 TASK_SETTLED   ·  DELETE = inactive        adm
GET|POST|PATCH|DELETE /v1/pickups[...]      legacy facade over tasks     M      wei
```

**Products and inventory** (RSP-018…025)
```
GET|POST /v1/products {id,name,categoryId,storageUnitId}                W      adm
PATCH /v1/products/{id} {status:"inactive"}                             W      adm
GET  /v1/inventory?productId&plotId&warehouse   -> derived stock          M W R wei
POST /v1/inventory/entries {id,productId,quantity,plotId,
                            plotCropId,warehouse?}  -> {entry, labelBatchId}     adm
GET  /v1/labels/{labelBatchId}  -> sticker PDF                           W      adm
```
**Stock is derived from movements, never stored and never written**, for exactly
the same reason the balance is derived from the ledger: a saved total is a total
that will lie one day. RSP-025 says "on save it prints the stickers"; the server
**does not print** — it generates the label batch and returns its id. Printing
belongs to the client.

**Sales and expenses** (RSP-026…032)
```
GET|POST /v1/sales    {id,productId,quantity,amountCents,customerId,receiptMediaId}  W adm
GET|POST /v1/expenses {id,amountCents,scope:"activity"|"plot_crop",
                       activityId?|plotId+plotCropIds[],note}                        W adm
PATCH /v1/{sales|expenses}/{id} {status:"inactive"}                                  W adm
```
**An ambiguity to hand back to the owner:** RSP-030 calls the cost of an
activity a "gasto" (expense), and RSP-008 calls what an employee owes the farm a
"deuda" (debt). **They are not the same thing and they cannot share a table.**
An `expense` is the farm's accounting and **never touches the worker's ledger**;
a "debt" in RSP-007/008 is a `deduccion` in the ledger. Mix them and recording
the cost of a spraying would dock money from somebody's wages. Here they are
kept apart, on purpose.

**Configuration**
```
GET|PUT /v1/farm {name,phone,areaHa,country,city,address,timezone,currency}   W  own
GET|POST|PATCH /v1/users                                                       W  own
```
"Setting work prices" and "User management" are marked *still to be specified*
in the document. We ship the minimum that unblocks (`PUT /v1/activities/{id}/rate`
and creating a user with a role) and leave the question written down for the
owner: **does an activity's price have a dated validity history, the way the
weekly picking price already does?** If the answer is yes, that is one more
table and we need to know before writing the code, not after.

---

## 3. Cross-tenant service (RSP-004, RSP-009)

**It does not break the tenant-in-the-token rule: it sidesteps it by design.**
The registry is a **separate service**, its own schema, its own credentials, no
access to the farm schema and no route that returns a row from a tenant. The
farm token is exchanged for one with `aud: "registry"`; there, `farm_id`
**authorises reading nothing** — it is the subject of the audit log and the key
for the quota. The search key is the *cédula*, a global namespace, not a tenant.

```
POST /registry/v1/lookups
  {documentType, documentNumber, purpose:"hiring", authorizationRef}
  -> {found, farmsWorked:3,
      employmentSpans:[{from:"2024-01", to:"2024-06"}],   -- months, never days
      openDisputes:0, claims:[]}                          -- empty while the flag is off
GET  /registry/v1/lookups/{id}            -- async result, for the no-internet case
GET  /registry/v1/subjects/{docHash}/access-log    -- who looked me up (the worker reads it)
POST /registry/v1/disputes {recordId, reason}
```

**Public:** that the *cédula* exists and is verified, **how many** farms, in
which **months**, and whether there are open disputes. **Never, not even to the
super-admin:** the names of the farms, balances, debts, advances, amounts,
kilos, productivity, specific work records, phone, address, photo. The
projection is fixed in code, not configurable — a configurable field ends up
switched on.

**Who may call:** only an `owner`/`administrator` of an active farm that has
explicitly opted in, with a quota (say 50/day) and an `authorizationRef`: the
farm **declares** that it holds the candidate's written authorisation. Without
that field, `403 NO_AUTHORIZATION`. It is what Law 1581 of 2012 requires anyway,
and it turns a silent lookup into an attributable act.

**It is always logged** (RSP-009 asks for it as a postcondition): `farm_id`,
user, `purpose`, timestamp, yes/no outcome. And — this is the half that actually
protects anyone — **the worker can read it**. When somebody is registered as an
employee, they are told who looked them up before hiring them.

**With no internet** (RSP-004): `POST /v1/workers` accepts the creation and
queues the lookup; `GET /v1/workers/{id}/background-check` returns
`pending|ready`. **The lookup never blocks creating the employee.** A service
that is down cannot stop somebody from starting work.

### The warning, so the owner decides with his eyes open

RSP-009 includes **the notes written about the person** among the "public data".
That is the blacklist, literally. The RSP-007 notes are free text one farm
writes about a person; publishing them by *cédula* to any other farm produces a
defamatory file — distributed, unverifiable, and unknown to the person it
describes. With that, an angry foreman leaves somebody out of work across a
whole region, and the platform is jointly liable.

**Operational recommendation:** notes are born with `visibility='private'` and
**never leave the farm, ever**. Sharing a fact is a different kind of record
(`shared_claim`) that only gets built if the owner asks for it, and only with
all five properties together: **(1)** a fact from a closed, verifiable
catalogue, not free text; **(2)** attributed to a farm identifiable to the
worker; **(3)** notified to the person when published; **(4)** disputable, and a
dispute **hides it from lookups while it is being resolved** — it fails closed:
an accusation in doubt does not circulate — with 15 days to substantiate it or
it is withdrawn; **(5)** automatic expiry at 24 months.

Without all five, it is a weapon. **Delivery 2 builds only the employment
periods and the lookup log** — cheap, useful, defensible — and leaves `claims`
returning `[]` behind a flag that is off. Switching it on is the owner's
decision, taken in writing, not an `if` somebody flips on a Tuesday.

---

## 4. Polygons: **PostGIS from the start**

A polygon in `jsonb` is decoration: it does not validate, does not calculate and
does not answer questions. The day somebody asks "how many hectares does this
plot really have?" or "does this plot overlap the neighbour's?", every query has
to be rewritten *and* the data backfilled with polygons that may no longer be
valid. PostGIS is an extension available on RDS, Cloud SQL and Supabase;
adopting it costs one line of migration (`geography(Polygon,4326)`) and uses
**three** functions and no more: `ST_IsValid` (reject self-intersecting
polygons, `400 INVALID_GEOMETRY`), `ST_Area/10000` (the calculated hectares
RSP-001 will end up needing alongside the declared ones) and `ST_Intersects`
(warn about overlaps). At the HTTP boundary everything goes in and out as
**GeoJSON**, so the web and the mobile app never see PostGIS and changing engine
stays possible. We are not building a GIS product; we are building the ability
to answer three questions.

---

## 5. Public catalogue (RSP-010, RSP-018): **a separate service, and it is imported by copy, not by reference**

It is a global read-only service — `GET /catalog/v1/activities?since=` and
`/catalog/v1/products?since=`, versioned by snapshot, cacheable, no auth — and
**not** a shared schema inside the multi-tenant API: mixing a global table with
no `farm_id` into a database with RLS active is precisely the exception somebody
copies wrongly one day.

The important decision is not where it lives but **how it comes in**:
`POST /v1/activities/import {catalogIds[]}` **copies** the rows into the farm's
tables and keeps `source_catalog_id` only as provenance. Never a foreign key
crossing the boundary. Reason: if a farm's activity *references* the global
catalogue, then the day somebody renames "Recolección por kilos" or changes its
unit, it changes underneath work records that have already been settled — data
that decides money, mutating from outside and with no audit trail. Copying also
means the farm keeps working when the catalogue is down, which is always half
the season.
