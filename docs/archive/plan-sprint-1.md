# Sprint 1 — Báscula: the multi-tenant skeleton and the cycle of paid work

## 1. Goal and demo

**Goal:** get the cross-cutting module running (farm, users, permissions, soft
delete) and **one complete chain of value: plot → employee → activity → work
record → balance → payment**, built with the pattern the other six modules then
copy.

**Demo (20 min, one thread):** register the farm "La Esperanza" and its owner →
log in → create a plot (department/municipality, area, two crops) → three
employees with photo and ID document → two activities: *Recolección de café*
(paid by unit of work, $800/kg) and *Guadañada* (paid by unit of time) → record
two days of work on that plot → open an employee's profile: balance and
financial history → pay them → balance at zero, the payment sits in the history
→ try to enter the employees module with a user who lacks the permission and the
API refuses → a second owner from another farm sees nothing of the first. Close
with `npm test`, the mobile app's 75 tests green.

## 2. The cut, and why

**In:** AUTHENTICATION + FARM SIGNUP, CONFIGURATION (farm details, prices and
users only), PLOTS **without the polygon**, EMPLOYEES, ACTIVITIES, WORK RECORDS.
**Waiting:** PRODUCTS/INVENTORY and stickers, SALES, EXPENSES, the map polygon,
notes, RSP-009 (cross-tenant).

The line is not drawn by what is easy:

- **Auth, permissions and soft delete are a prerequisite for all 33 cases**:
  every one of them starts by checking a permission and none of them hard
  deletes. It gets built once as a pattern and the other modules consume it.
- **WORK RECORDS is the heart of the business and the knot of dependencies**: it
  needs an employee, an activity and a plot/crop. Delivering it forces all three
  to be modelled properly. If we did SALES or INVENTORY instead — simpler CRUD —
  we would have more cases closed and no risk resolved.
- **EXPENSES and SALES are money that depends on nobody**: they can be done in
  any sprint, in parallel, blocking nothing. That is why they wait.
- **The map polygon comes out of PLOTS, not the plot itself**: it is the
  expensive part (library, drawing, geometry in Postgres) and it does not block
  WORK RECORDS, which only needs the plot id. A plot is born with a name, a
  location, an area and crops; the map is added on top in Sprint 2.
- **The photo and the receipt push file storage in**: only the employee photo
  goes in (one upload route), and that same route later serves sale receipts and
  stickers.

## 3. The tension in the model: take the general model, now

**Team decision (not the owner's): Sprint 1 models picking as an ACTIVITY paid
by unit of work (kg), not as an entity of its own.** The mobile app is not
touched.

- *Take the general model (chosen):* a schema that holds all 33 cases from the
  first commit. The cost is that the server's payroll and the phone's stop being
  the same code for a few weeks. Mitigated by the golden cases (H10): a picking
  work record has to produce **exactly the same cents** as the mobile app's
  `BALANCE_SQL`, case by case, or the sprint does not close.
- *Defer it:* Sprint 1 ships a week earlier and then the schema, the API and the
  web all have to be redone, and production data migrated — right in Sprint 3,
  on top of sync, which is the part that can lose money. That is the worst
  possible combination.

Practical consequence: `pickups` does not exist in Postgres. What exists is
`labores` with `modalidad_pago ∈ {contrato, tiempo, trabajo}` and
`cantidad + unidad`; picking is `trabajo/kg`.

## 4. Stories, in dependency order

**H1 · Contract and module pattern** (M · Architect + BE1) — *As a team I want a
contract and a module template so that ten modules are not written ten different
ways.* AC: OpenAPI 3.1 in `packages/shared`; generator for TS types and Go
structs, CI fails on a diff; documented template covering list/create/modify/
soft-delete, permission check at the door, required-field validation and a
uniform error response; money in cents, UUID ids.

**H2 · Farm signup, auth and permissions** (L · BE2) — AC: farm signup with its
first owner user; login/refresh carrying `farm_id` and role; the
owner/administrator/weigher matrix enforced **on the server** with a test per
role and per module; `403` documented; argon2id and rate limiting.

**H3 · Multi-tenant schema with RLS and soft delete** (M · DBA + BE1) — AC:
`farm_id` and `deleted_at` on every table; RLS keyed on `app.farm_id`, an
application role without `BYPASSRLS`; a two-seeded-farms test that proves the
isolation; no route runs a `DELETE`.

**H4 · Plots and crops** (M · BE1) — AC: a plot with name, department,
municipality, area and **several crops**; plots within the plot; a `poligono`
column in the schema, no endpoint yet; a soft delete that does not orphan work
records.

**H5 · Employees** (M · BE2) — AC: identification unique per farm, photo
uploaded to storage, a profile that returns the balance derived from the ledger
and a paginated financial history; soft delete keeps the history.

**H6 · Activities** (S · BE1) — AC: category, unit and the three forms of
payment with their rate; validation that the rate matches the form of payment.

**H7 · Work records** (L · BE1 + BE2) — AC: an employee performs an activity on
a plot and crop with a date and a quantity; it produces a `devengo` in the
ledger calculated according to the form of payment; a work record that has been
settled is not modified or cancelled without a `reverso`; the golden cases pass.

**H8 · Pay and register a debt** (M · BE2) — AC: `pago`, `anticipo` and
`deduccion` as ledger rows; the credit balance comes out right; nothing is
edited, it is reversed.

**H9 · Web: shell, farm signup and login** (M · FE1) — AC: Vite+React+TS, client
generated from the OpenAPI (zero hand-written types), MSW with those same mocks;
module navigation that hides what the role cannot reach.

**H10 · Web: reusable list/form + plots and employees** (L · FE2 + FE1) — AC: one
module component (table, search, create, edit, soft delete with confirmation)
used by both; plot creation follows the cropti/farmlogs pattern: step 1 identity
and location by department/municipality, step 2 crops, **with the map's space
laid out and disabled** so that Sprint 2 only has to fill it in; employee photo
with cropping.

**H11 · Web: activities, work records and employee profile** (L · FE2) — AC:
recording a work record in a few taps (employee → activity → plot → quantity);
profile with balance, history and pay/register-debt buttons.

**H12 · Shared money domain + golden cases** (L · MOB1 + MOB2) — AC:
`ledger/harvest/week/format` moved into `packages/shared` with their tests, with
no behaviour change on the phone; `golden/*.json` covering picking-as-work-record,
credit balance, `anticipo` and voiding, running in both the TS **and** the Go CI.

## 5. Who does what

| Who | Sprint 1 |
|---|---|
| **BE1** | H1 with the architect → H3 with the DBA → H4 → H6 → H7 |
| **BE2** | H2 → H5 → H8 → H7 |
| **FE1** | H9 → H10 plots → H8 on the web |
| **FE2** | H10 module component + employees → H11 |
| **MOB1/MOB2** | H12; afterwards, a `Repository` layer on the phone so SQLite can be swapped for the API in Sprint 3 without touching screens |
| **Architect** | H1 days 1–2, then referee of the contract and reviewer of PRs |
| **DBA** | RLS, indexes, file storage, a backup that has been restored |

The mobile team writes no HTTP client and no sync: it works on the one thing
that is already certain (the money logic, with tests) and produces the
executable specification that Go has to match.

## 6. Risks

- **The general model turns out badly calibrated against 33 cases written by
  someone else and not read by us.** Mitigation: the RSP document lands in the
  repo on day 1 and the architect maps every case to a table before the first
  migration.
- **TS and Go drift.** OpenAPI is the single source, generation in CI, nobody
  writes types by hand.
- **The web blocked on the API.** By day 3 every endpoint exists with the right
  contract and seeded data; the front end runs on MSW and switches over with an
  environment variable.
- **Go calculates differently from the phone.** The goldens are a blocking test.
- **Ten modules in ten styles.** The H1 template and the H10 component are an
  acceptance requirement of any module PR.
- **Breaking the mobile app in production.** Only refactoring covered by the 75
  tests, no release.
- **RSP-009 creeps in.** Out of the sprint by explicit decision; see below.

## 7. Three decisions for the owner

1. **RSP-009 (an employee's history at other farms).** It is a third party's
   personal data and it breaks isolation by design; the team does not get to
   decide it. Do we (a) drop it from the product; (b) build the minimal version
   — signals only: "this document exists at N farms" or "has an active alert",
   never kilos, payments or farm names, with a record of who looked and the
   employee's signed authorisation at signup; or (c) share the full history,
   which requires legal advice on habeas data before a line is written?
2. **Farm signup.** Your document has FARM REGISTRATION (self-service) and you
   asked for a super-admin who creates them. Do we (a) open self-service with
   email verification; (b) have only the super-admin create them and hand over
   credentials; or (c) allow self-service but the farm is born on trial and the
   super-admin activates it?
3. **Your farm during the transition.** Until sync exists (Sprint 3), does (a)
   the web record work records from now on, accepting that the phone and the
   server keep separate books for a few weeks; or (b) the web only administers —
   plots, employees, activities, prices, users — and recording work stays
   exclusive to the mobile app?

## 8. Next backlog

**Sprint 2 — Close money and the map.** EXPENSES by activity and by plot · SALES
with a photo of the receipt · plot polygon on a map in the cropti/farmlogs
style, with calculated area · full CONFIGURATION (historical prices, users and
invitations) · employee notes · settlement and PDF receipts from the web · a
queryable audit log.

**Sprint 3 — Inventory and sync.** PRODUCTS and INVENTORY with stickers and
movements · mobile sync (UUIDs, idempotent push/pull, server owns the settlement
lock, conflicts screen) · the mobile app reading its farm from the API · phone
picking migrated to a work record · reports and performance on the web · suspend
a farm · observability and backups.
