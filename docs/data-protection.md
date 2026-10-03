# Data protection

How Bascula handles personal data, mapped against Colombia's Ley 1581 de
2012 (habeas data) and Decreto 1377 de 2013. One page, meant for a
buying farm to read before signing up and for the maintainer to point at
when a regulator or a worker asks.

> This document reflects the schema and the code on `master` today.
> [`docs/database.md`](database.md) is the authoritative diagram
> (regenerated with `make db-diagram`; CI fails a PR whose committed copy
> does not match the migrations), [`docs/data-model.md`](data-model.md)
> is the narrative design, and [`docs/decisions.md`](decisions.md) carries
> the owner decisions this file points at. If a migration changes the
> shape of any table named below, the PR that lands the migration updates
> this file in the same PR.

## Roles under Ley 1581

- **Each farm is the _responsable del tratamiento_.** The worker data on
  the farm's tenant belongs to the farm and is processed under the farm's
  authority. The farm is the party that must obtain and keep the worker's
  authorisation at hiring; the form of that authorisation is the farm's
  responsibility.
- **Bascula is the _encargado del tratamiento_**, operating the platform
  on the farm's behalf. Signup today does not show or record acceptance
  of any terms of service or data-processing agreement; that is a stated
  gap (see [What is pending](#what-is-pending)). Bascula never decides on
  its own what to do with worker data, and the super-admin console cannot
  read it (see [Worker identity](#worker-identity--publicemployees)
  below).
- **Plot location is not personal data** under Ley 1581; it is the farm's
  own operational data and is documented here only for completeness.

## Data categories, mapped to tables

The authoritative shape of each table is in
[`docs/database.md`](database.md); only the columns that matter for this
document are listed here.

### Worker identity — `public.employees`

- **Columns.** `name`, `last_name`, `document_type`, `doc_id` (cédula or
  equivalent), `tag`, `phone`, `address`, `city`, `municipality`,
  `country`, `photo_id` (FK to `attachments`), `kind`. Soft-delete columns:
  `deleted_at`, `deleted_by`.
- **Who can read.** The farm's own roles only. Row-level security is
  enabled, forced and policy-covered on every table carrying `farm_id`;
  [`docs/audits.md`](audits.md) records 67 cross-farm attempts that
  returned the same answer "not yours" as "does not exist" (no route
  leaked existence by code, message or timing). The super-admin console
  cannot read a farm's employees — see
  [`docs/decisions.md`](decisions.md) 2026-08-28 §2.
- **Retention.** `deleted_at` is a soft delete. Decision 8 in
  `decisions.md` is relevant: a deleted worker who turns up with new work
  is reactivated automatically, and the reactivation is recorded in
  `public.employee_reactivations` with the work record and the device that
  triggered it (migration `00014_reactivation_and_prune.sql`). There is
  no scheduled hard-delete of worker rows today.
- **Rights.** Access, correction and deletion requests go through the
  farm, which runs the request against the admin console. Bascula does
  not act on worker requests directly except as the technical
  intermediary when the farm asks for help.
- **Status.** Access and correction fully implemented; deletion is a soft
  delete today, and a hard-delete policy is pending (see
  [What is pending](#what-is-pending)).

### Worker notes — `public.employee_notes`

- **Columns.** `body` (free text), `noted_on`, `visibility`.
- **Lead decision.** The row is born with `visibility = 'private'` and
  **has no route out** — not even into the cross-farm registry.
  [`docs/decisions.md`](decisions.md) 2026-08-28 §1 is explicit: the
  schema is the defence, not a written policy somebody can step around.
- **Who can read.** Only the farm's admin and owner roles (per the role
  policies attached in the migration that creates the table).
- **Retention.** Lives while the employee row lives; follows the same
  soft-delete model.

### Worker employment history — `public.work_records`

- **What it holds.** The day's work: date, employee, plot, activity,
  productivity, plus a free-text `note` column (migration
  `00005_work_records.sql`).
- **Who can read.** The farm that recorded it only (RLS by `farm_id`);
  within the farm, owner and admin read every record and a weigher reads
  only the ones he created (`00008_rls.sql`).
- **Retention.** Indefinite while the farm is active. Work records are
  the ledger's referents, so pruning them is not safe without pruning
  what points at them.
- **Status.** `note` is free text, so nothing in the schema stops a
  recorder from writing a judgement about a worker there; it stays on the
  farm (it is never meant to cross into the registry), but it is personal
  data the farm answers for. The schema-level "nowhere to write a
  judgement" defence applies to the registry, not to this table (see
  [Cross-farm registry](#cross-farm-registry--designed-not-switched-on)
  below).

### Worker payments — `public.settlements`, `settlement_items`, `settlement_releases`, `ledger`

- **Shape.** Weekly settlements aggregate `ledger` entries. The ledger
  itself holds one row per movement with a `kind` enum (`ledger_kind`:
  `devengo`, `pago`, `anticipo`, `deduccion`, `ajuste`, `reverso`); there
  is no separate "advances" or "movements" table — the kind column is how
  one row is distinguished from another. Voiding is a settlement status
  (`settlement_status`: `open`, `void`), not a ledger kind.
- **Who can read.** The owner and admin roles on the owning farm (the
  roles are `owner`, `admin` and `weigher`; there is no accountant role); the
  weigher is denied every money route (`docs/audits.md`: "The weigher
  gets 403 at every door to money and personal data"). RLS enforces
  farm boundary; roles enforce the within-farm boundary.
- **Retention.** Indefinite. This is accounting data the farm needs for
  its own obligations under tax law.
- **Cross-farm visibility.** None. The registry (see
  [Cross-farm registry](#cross-farm-registry--designed-not-switched-on))
  is designed to publish periods of participation, never amounts.

### Plot location — `public.plots`

- Not personal data under Ley 1581; documented here for completeness.
- **Columns of note.** `boundary` and `location` are PostGIS
  `geography(MultiPolygon,4326)` and `geography(Point,4326)`.
- **Retention.** Lives while the farm is active; soft-delete via
  `deleted_at`.

### Account owner identity — `public.users`, `public.memberships`, `public.farm_owner_credentials`

- **Columns.** `users.email`, `users.name`, `users.password_hash` (argon2id),
  `users.phone`, `users.email_verified_at`. Role is held in
  `memberships(farm_id, user_id, role)`. `farm_owner_credentials`
  (migration `00032`) is personal data too: for a farm registered with an
  address that already had an account, it stores the `name` and `phone`
  typed on that registration and that farm's own owner `password_hash`,
  keyed by `(farm_id, user_id)`.
- **Who can read.** The user themselves. `farm_owner_credentials` rows
  are readable from inside their farm or by the user they belong to
  (`00037`). The super-admin console sees the farm and can suspend it
  (`farms.suspended_at`) but does not read users across farms.
- **Signup.** Where mail is configured, signup does not mark the address
  verified: the owner confirms it from a mailed link, and only then is
  the farm's own stack built. An account nobody has verified is a claim:
  the latest registration of that address replaces its password, name and
  phone and voids earlier links (PR #310).
- **Retention.** No scheduled anonymisation of `users` today. A row stays
  while any owned farm exists.
- **Rights.** Direct Bascula contact goes through the private advisory
  thread on `SECURITY.md` until a dedicated privacy mailbox exists
  (see [What is pending](#what-is-pending)).

### Auth and recovery — `email_verifications`, `password_resets`, `refresh_tokens`, `passkeys`, `passkey_used_challenges`, `oauth_clients`, `oauth_codes`

- **Lead.** Not everything here is stored the same way:
  - `email_verifications`, `password_resets` and `refresh_tokens` keep
    only a hash of the secret (`token_hash bytea`) with an expiry. None of
    the three is pruned on a schedule today; used and expired rows stay.
  - `passkeys` holds no secret: it stores the credential's public-key
    `record` (`jsonb`: public key, sign count, flags, transports, AAGUID),
    the `credential_id`, a user-chosen `name` and `last_used_at`; no token
    hash, expiry or used flag. A password reset by email deletes every
    passkey on the account (PR #291), and every farm-specific owner
    password in `farm_owner_credentials` with it.
  - `oauth_codes` stores the authorisation `code` and the `access_token`
    it will hand out **in plaintext**. They are short-lived: a code is
    deleted when it is exchanged, and each new code insert sweeps codes
    that expired more than an hour earlier
    (`services/api/internal/store/oauth.go`).
  - A used passkey challenge is kept, hashed, only until it would have
    expired on its own; `passkey_used_challenges` is pruned by
    `api -prune` on that condition (see
    [Retention schedule](#retention-schedule)).
- **Who can read.** The user themselves. The server reads these at
  verification time only; they do not surface in any console view.

### Operational and audit logs — `public.login_failures`, `public.signup_attempts`, `public.mcp_audit`, `public.sync_log`, `public.sync_ops`

- **`login_failures`** — `(ip, email, at)` on every refused sign-in.
  Retention: **30 days**, pruned by `api -prune`
  (`services/api/internal/store/sync_prune.go`, `LoginFailureRetentionDays`).
- **`signup_attempts`** — `(ip, email, at, succeeded)` on every signup
  attempt; the limiter reads it. No scheduled prune today.
- **`mcp_audit`** — one row per MCP write-tool execution (previews are
  not recorded): `farm_id`, `user_id`, `client_id`, `tool`, `outcome`,
  `summary`, `args`. Read by the farm's owner and admin (RLS). No
  scheduled prune today.
- **`sync_log`** — append-only change feed; **DELETE is revoked** from
  the application role and a trigger raises on any attempt. Pruning
  deletes **superseded rows only** (same `(farm_id, entity, row_id)`
  with a newer entry) and runs out of band as `api -prune` under the
  admin role; retention floor is **180 days** so a handset that fell
  behind by one harvest cycle can still catch up incrementally.
- **`sync_ops`** — idempotency memory for sync envelopes; **30 days**.
- **`ledger`** — never pruned. Its feed rows are `append` and every
  movement must survive a bootstrap. Called out explicitly in
  `sync_prune.go`'s header: "The ledger is never pruned. Its feed rows
  are `append` and there is one per entry, so none is ever superseded."

## Cross-farm registry — designed, not switched on

The `registry` schema exists as an empty schema on every farm
(`services/api/migrations/00007_registry_schema.sql`). The design,
drawn in [`docs/data-model.md`](data-model.md) §D ("The cross-tenant
requirement"), is on the record:

- The identity stored is a **hash** (sha256) of
  `pepper || doc_type || '|' || doc_id` with a server-side pepper, in
  `registry.identities`. A dump of the table does not hand over a list of
  cédulas.
- `registry.employment_spans` holds **presence**: hash, farm, start and
  end dates, and a `disclosable` boolean that defaults to `false`. That
  boolean is the originating farm's publishing switch, not a mark on the
  person. The farm opts in to publishing; without opt-in, a lookup
  returns zero rows.
- Every lookup leaves a row in `registry.lookups` with the user and the
  farm that looked and a mandatory `reason` of at least 10 characters.
  The table is append-only by rule, not by habit.
- The only door is `registry.lookup(doc_type, doc_id, reason)`, a
  `SECURITY DEFINER` function that caps lookups at **50 per farm per
  day** and records every query it answers.
- What the drafted function returns: `(farm_name, started_on, ended_on)`
  for every disclosable span of that identity at another farm. The farm
  name is not stored in the schema; it is joined from `public.farms` at
  lookup time. This contradicts the comment in migration `00007` and
  `decisions.md` 2026-08-28 §1, which say the names of the farms never
  leave; the conflict is open and must be settled before the registry is
  built (see [What is pending](#what-is-pending)).
- What never crosses the schema boundary: `employees`, `employee_notes`,
  `ledger`, `work_records`, balances, debts, advances, kilos,
  productivity, phone, address or photo — even for the super-admin.

**Why it is off.** `decisions.md` 2026-08-28 §1 is explicit: the
registry is not switched on until the worker-facing "who looked at me"
screen exists. The schema is drawn, the function is designed, the
decision is "do not enable it without that screen", and until then it
remains an empty schema in production.

**Why the shape is what it is.** Built badly, a cross-farm registry is
a labour blacklist, which under Ley 1581 would make Bascula liable for
an automated decision affecting a worker without authorisation. The
design has **no free-text column, no score and no flag about the
person** on `employment_spans` (migration `00007` and `decisions.md`
2026-08-28 §1) — the only boolean, `disclosable`, is the farm's
publishing switch — not because a policy document says so, but because
there is nowhere in the table to write a judgement.

## Rights, in practice

| Right                     | How a worker exercises it           | How Bascula answers                             |
|---------------------------|-------------------------------------|-------------------------------------------------|
| Access                    | Ask the farm admin                  | Admin console shows the full record             |
| Correction                | Ask the farm admin                  | Admin console edits                             |
| Deletion                  | Ask the farm admin                  | Soft delete (`employees.deleted_at`)            |
| Portability (export)      | Not implemented                     | Pending (see [What is pending](#what-is-pending)) |
| Revoke registry opt-in    | Not applicable yet                  | The registry is off in production (see [Cross-farm registry](#cross-farm-registry--designed-not-switched-on)) |
| See who looked at me      | Not applicable yet                  | Pending; it is the gate for switching on the registry |

Account owners can read their own profile (`GET /v1/me`) and, from the
console, change their password, add and remove passkeys, and close
sessions. They cannot change their email, name or phone themselves:
rectification of those is a request — a member asks the farm's owner,
and the request reaches the operator through the advisory thread on
[`SECURITY.md`](../SECURITY.md), which is also where an owner writes. Self-service editing is
pending (see [What is pending](#what-is-pending)). Deletion of a user row
is not self-service today either — write to the maintainer through the
same advisory thread.

## Retention schedule

| What                                 | Rule                                                              | Where                                     |
|--------------------------------------|-------------------------------------------------------------------|-------------------------------------------|
| `login_failures`                     | 30 days                                                           | `sync_prune.go` `LoginFailureRetentionDays` |
| `sync_log` (superseded rows)         | 180 days floor; only superseded rows deleted                      | `sync_prune.go` `SyncLogRetentionDays`      |
| `sync_ops`                           | 30 days                                                           | `sync_prune.go` `SyncOpsRetentionDays`      |
| `passkey_used_challenges`            | until the challenge would have expired on its own                 | `sync_prune.go`                           |
| `ledger`                             | never pruned                                                      | `sync_prune.go` header                    |
| `employees` (soft-deleted)           | kept; reactivation on new work is recorded                        | `00014_reactivation_and_prune.sql`        |
| `settlements`, `work_records`        | indefinite while the farm is active                               | farm's accounting obligation              |
| `oauth_codes`                        | deleted on exchange; expired codes swept on each new code insert  | `oauth.go` `InsertOAuthCode`              |
| `signup_attempts`, `mcp_audit`       | no scheduled prune (pending)                                      | [What is pending](#what-is-pending)       |
| `email_verifications`, `password_resets`, `refresh_tokens` | no scheduled prune (pending)                | [What is pending](#what-is-pending)       |

The sweep runs out of band as `api -prune` under the admin role; the
application role cannot delete from the append-only tables even if it
tried.

## Breach notification

A sev-1 incident that confirmably exposed worker PII to another tenant
or to the public internet runs the chain in
[`SECURITY.md`](../SECURITY.md) ("Supported versions" and the private
advisory flow) and [`docs/incident-response.md`](incident-response.md).
As _encargado_, Bascula's duty to report to the SIC is Ley 1581
Art. 18(k) (Art. 17 binds the farm as _responsable_). What happens today:

1. Users, including the affected farms, are told once the fix is live
   and the advisory publishes: the GitHub release notes and the published
   advisory explain what happened and what, if anything, farms should do,
   with anything farms read directly written in plain Spanish
   (`incident-response.md`, "Communication"). There is no 24-hour farm
   notice and no in-system notice today; both are pending (see
   [What is pending](#what-is-pending)).
2. Notification to the SIC (Superintendencia de Industria y Comercio)
   on the regulator's channel when the exposure is confirmed and
   scoped, within the window set by the SIC's current guidance for
   data breaches.
3. A public post-mortem in [`docs/audits.md`](audits.md) once the fix
   is live — the file is already the scoreboard for adversarial
   findings, and an incident lands in the same shape.

Containment runs first, and the fix is backed by a red test that fails
without it (the project's closure rule: see `audits.md`'s header).

## What is pending

Each item below is a stated gap, not a vague "TBD":

- **Worker data export.** Workers have no accounts, so a `/v1/me/...`
  route (scoped to the signed-in user) cannot serve them. What is missing
  is a farm-side export: an owner/admin route that returns one worker's
  rows across `employees`, `employee_notes`, `work_records` (including
  `note`), `settlements` and `ledger`, for the farm to hand to the
  worker. Red test: the response includes every row the farm would show the worker on
  request.
- **Terms of service and data-processing agreement at signup.** Signup
  records no acceptance today. The farm's agreement naming Bascula as
  _encargado_ has to be shown and its acceptance recorded.
- **Self-service profile editing.** Users cannot change their email,
  name or phone; only `GET /v1/me` exists. An edit route (with the new
  address re-verified) replaces the request-to-the-operator channel.
- **Breach notice to farms.** No 24-hour notice and no in-system notice
  exist; farms learn of an incident from the release notes and the
  published advisory after the fix ships.
- **Registry: farm names.** The drafted `registry.lookup` in
  `data-model.md` §D returns `farm_name`, against migration `00007` and
  `decisions.md` 2026-08-28 §1. Settle which one is right before the
  registry is built.
- **Formal privacy notice at hiring.** Spanish-language notice shown and
  acknowledged on the farm's admin flow when adding an employee, with a
  signed-confirmation column on `employees`. UI text in Spanish (per
  the project convention), server text in English.
- **Dedicated privacy mailbox.** A `privacy@` address routed to the
  same maintainer as the private advisory thread, documented here and
  in [`SECURITY.md`](../SECURITY.md).
- **Worker-facing "who looked at me" screen.** Reads
  `registry.lookups` by hash and is the gate for switching on the
  cross-farm registry. The function and the table exist in the
  design; the screen does not.
- **Scheduled prune for `signup_attempts`, `mcp_audit`,
  `email_verifications`, `password_resets` and `refresh_tokens`.** All
  grow without bound today; the last three keep used, revoked and expired
  token hashes. The horizon is the same question as for
  `login_failures` — an incident nobody looked at within a month is
  not going to be looked at — but no retention is wired yet.
- **Hard-delete of a worker at the end of a retention window.** Soft
  delete exists; a dated hard-delete policy that strips identifying
  columns from `employees` once there is no live claim against them
  (last work record, last ledger entry, last settlement) does not.

Each of these ships as its own PR with its own red test.
