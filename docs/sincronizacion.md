# Báscula — Mobile ↔ server sync

A delivery specification. It is written so that two pairs can implement it
without having to ask again: every section says **what gets done**, not **what
the options are**. Where an option is genuinely open, it is in §10 and it is the
owner's.

The system it talks about already exists and is in production:

- The mobile app runs on one farm, mid-harvest, on SQLite `user_version = 5`,
  with `INTEGER PRIMARY KEY AUTOINCREMENT` primary keys.
- The server has 66 routes, Postgres with RLS, UUIDv7 on every table, and the
  double-payment lock in `ux_items_payable_live`.
- The owner's decision 3 put the web to work recording work records **now**. Two
  truths exist as of today, and today paying from both sides pays twice.

Nothing that follows may lose or duplicate a weighing, a settlement or a payment
that already exists on that farm's phone.

---

## 0. What this document closes, and what it clashes with

### 0.1 The five decisions

1. **The server owns the lock. The phone does not settle without having
   synced.** Cash handed over in the field with no signal is recorded as an
   `anticipo`, which needs no lock because it claims no weighing. §6.
2. **The phone does not change its primary keys.** It adds a `uuid` column to
   each table, backfills it, and syncs by UUID. The integers stay for local
   joins. §1.
3. **The mechanism is a change feed with a per-farm sequence**, not push/pull
   with a per-table watermark. The phone carries a single number. §3.
4. **Direction is decided table by table and is not symmetric.** Prices and
   plots are read-only on the phone; weighings and money movements are
   writeable; balances and reports never travel. §2.
5. **No conflict is resolved in silence.** Either a rule written here resolves
   it, or it ends up in front of a person with a name, a date and an amount.
   §5, §7.

### 0.2 Where it clashes with what is already written

| Document | What it says | What this document decides |
|---|---|---|
| `sync-and-roles.md` | "a settlement carries the set of pickup ids it claims, and the server rejects a settlement claiming a pickup that another settlement already holds; the rejected device re-derives" | **Rejected.** Re-deriving does not give back cash that already left somebody's pocket. The phone does not settle without syncing. §6 |
| `sync-and-roles.md` | ordering by "a per-device counter plus arrival order at the server" | **Replaced** by the server's commit sequence with an `xmin` horizon. There is one server: distributed clocks are not needed. §3.4 |
| `modelo-datos.md` §3 | "the mobile app adds a `uuid` column to each table and backfills it, keeping its integer PK" | **Confirmed and detailed.** §1 |
| `modelo-datos.md` rev. 2 | the payable table is called `labors`; a `pickups` view exists | **Obsolete.** The migrations created `work_records` and there is no `pickups` view. Compatibility comes from the HTTP facade `/v1/pickups`. |
| `openapi.yaml`, conventions | "every write accepts a client-supplied `id` and is idempotent on `(farm_id, id)`" | **Today this is false for the ledger.** `store.AddLedgerEntry` does a bare `INSERT`; re-sending a payment after a timeout collides with the PK. It is a bug and it has to be fixed before push is switched on. §4.2 |
| `arquitectura-api.md` §8 | "offline sync: not now" | This document **is** that later. Its deadline is no longer set by a preference but by the facade: `/v1/pickups` can only translate `cropId → plot_crop` while the relation is 1:1. §8 |
| `decisiones.md` §3 | "during the transition, pay from one side only" | That mitigation **does not end when sync is deployed**, but at phase 6 of §8. Before that they are still two databases. |

---

## 1. Identity: from `INTEGER AUTOINCREMENT` to UUIDv7

### 1.1 The rule

The phone does **not** rewrite its primary keys. It adds `uuid TEXT` to each
syncable table, backfills it, and from then on generates it at insert time. The
integer stays the PK and stays the target of every local join, of
`settlement_items.pickupId`, of `ledger.settlementId` and of
`ledger.reversesId`.

The reason is risk, not taste. Rewriting the PK of `pickups` forces a rewrite of
`settlement_items.pickupId` **underneath the unique partial index that decides
who has already been paid**, in the database that today holds the only copy of a
farm's harvest. Adding a column cannot lose a row; rewriting a PK can. The cost
is ~36 bytes per row and one extra `JOIN` in the sync layer, and neither shows
up in this farm's ~55,000 rows a year.

### 1.2 The local migration, `user_version = 6`

```sql
-- apps/mobile/src/schema.ts, SYNC_SCHEMA, applied in migrate() under v < 6.
-- No statement in this block deletes, rewrites or reorders an existing row.
-- That is the property that makes it safe mid-harvest.

ALTER TABLE people           ADD COLUMN uuid TEXT;
ALTER TABLE crops            ADD COLUMN uuid TEXT;
ALTER TABLE pickups          ADD COLUMN uuid TEXT;
ALTER TABLE cost_overrides   ADD COLUMN uuid TEXT;   -- (farm, monday) on the server
ALTER TABLE settlements      ADD COLUMN uuid TEXT;
ALTER TABLE settlement_items ADD COLUMN uuid TEXT;
ALTER TABLE ledger           ADD COLUMN uuid TEXT;

-- The pointers, duplicated in their UUID form. The integer rules locally; the
-- UUID is the only thing that leaves the phone.
ALTER TABLE pickups          ADD COLUMN personUuid   TEXT;
ALTER TABLE pickups          ADD COLUMN cropUuid     TEXT;
ALTER TABLE settlement_items ADD COLUMN payableUuid  TEXT;   -- ex pickupId
ALTER TABLE ledger           ADD COLUMN personUuid       TEXT;
ALTER TABLE ledger           ADD COLUMN settlementUuid   TEXT;
ALTER TABLE ledger           ADD COLUMN reversesUuid     TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_people_uuid    ON people(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_crops_uuid     ON crops(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pickups_uuid   ON pickups(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_settl_uuid     ON settlements(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_uuid     ON settlement_items(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_uuid    ON ledger(uuid);
```

### 1.3 The backfill

Yes, they get backfilled. And they get backfilled with a **UUIDv7 seeded from
the row's own `createdAt`**, not with v4 and not with `randomUUID()`:

```ts
/**
 * UUIDv7 whose timestamp field is the row's own createdAt, not now(). Two
 * consequences, and the second is the one that matters:
 *
 *  - ORDER BY uuid on the server reproduces the order the farm actually
 *    recorded things in, which is what makes an imported history read right;
 *  - the backfill is deterministic per row, so running it twice on the same
 *    database is a no-op, and a migration that dies halfway resumes.
 *
 * The 74 random bits are still random: two devices seeding from the same
 * millisecond do not collide.
 */
export function uuidv7At(createdAt: string): string { /* … */ }
```

The backfill walks the tables in dependency order
(`people, crops → pickups → settlements → settlement_items → ledger`) going
`WHERE uuid IS NULL`, in batches of 500, each inside a transaction. At the end,
the migration **verifies and fails loudly** if anything was left out:

```sql
SELECT (SELECT COUNT(*) FROM people           WHERE uuid IS NULL)
     + (SELECT COUNT(*) FROM crops            WHERE uuid IS NULL)
     + (SELECT COUNT(*) FROM pickups          WHERE uuid IS NULL OR personUuid IS NULL)
     + (SELECT COUNT(*) FROM settlements      WHERE uuid IS NULL)
     + (SELECT COUNT(*) FROM settlement_items WHERE uuid IS NULL OR payableUuid IS NULL)
     + (SELECT COUNT(*) FROM ledger           WHERE uuid IS NULL) AS missing;
-- missing > 0  =>  user_version is not advanced. An app that will not start is
-- preferable to an app that syncs half a harvest.
```

### 1.4 `settlement_items.pickupId`: exactly what happens to it

**It stays.** It is `INTEGER`, it still points at `pickups.id`, and it is still
the column `ux_items_pickup_live` lives on. The local lock is not touched,
because it is the only mechanism that today stops that farm paying twice, and
touching it is exactly the operation we cannot allow ourselves.

What gets added is `payableUuid`, filled from `pickups.uuid`, and it is the only
thing that travels. On the server that column is already called `payable_id` and
its index `ux_items_payable_live`. The correspondence is literal:

| Phone | Server |
|---|---|
| `settlement_items.pickupId` (INTEGER, local join) | — does not travel |
| `settlement_items.payableUuid` (TEXT) | `settlement_items.payable_id` (uuid) |
| `ux_items_pickup_live ON (pickupId) WHERE voidedAt IS NULL` | `ux_items_payable_live ON (payable_id) WHERE voided_at IS NULL` |

Both locks go on existing. §6 explains why that is not a problem once only one
of the two can create a settlement.

### 1.5 Two more things that have to be fixed on the phone for this to work

**(a) `pickups.remove` is a real `DELETE`.** Today:

```ts
remove: (id) => {
  if (pickups.isSettled(id)) throw new Error("SETTLED");
  db.runSync("DELETE FROM pickups WHERE id = ?", [id]);   // ← physical delete
},
```

A row deleted physically after having been pushed **resurrects on the next
pull**, because the server still has it and the phone no longer knows it killed
it. In `user_version = 6`, `pickups` gains `deletedAt TEXT`, `remove` becomes an
`UPDATE`, and every `schema.ts` query that reads `pickups` gains
`AND pk.deletedAt IS NULL`. It is the same discipline `people` and `crops`
already have, and the same the server has, where nothing runs a `DELETE`.

**(b) The phone's local day is the device's, not the farm's.** `DAY_OF` and
`WEEK_OF` are `date(col,'localtime')`: they use the phone's zone. The server
computes `local_day` with a trigger from `farms.timezone`. A phone with the
wrong zone sends a Sunday-afternoon weighing and the server files it in a
different week — which is golden case 04, the bug that has already happened
once.

The fix, in `user_version = 6`: the week and the day are **materialised at write
time**, in the farm's zone, using `Intl.DateTimeFormat` (which does carry the
timezone database):

```sql
ALTER TABLE pickups ADD COLUMN localDay TEXT;   -- YYYY-MM-DD in the farm's zone
ALTER TABLE pickups ADD COLUMN week     TEXT;   -- the Monday of localDay
ALTER TABLE ledger  ADD COLUMN localDay TEXT;
CREATE INDEX IF NOT EXISTS ix_pickups_week ON pickups(week);
CREATE INDEX IF NOT EXISTS ix_pickups_localday ON pickups(localDay);
```

and `WEEK_BY_DAY_SQL`, `WEEK_BY_WORKER_SQL`, `WEEK_GRID_SQL`, `WEEK_PLOTS_SQL`,
`WEEK_GRID_DAY_SQL`, `PENDING_SQL` and the five review rules move to grouping by
those columns instead of recomputing `date(x,'localtime')` on every query. It is
the same move the server already made and for the same reason, with the side
effect of making sargable a set of queries that today scan the table.

Until the farm receives that version, the farm's zone comes from the handshake
(§3.1) and until then `America/Bogota` is assumed, which is what that phone has
set.

**(c) The price is stored as `REAL`.** `config.costPerUnit` and
`cost_overrides.costPerUnit` are `REAL` in pesos; the server has
`price_minor bigint`. Pulling a price from the server and storing it as `REAL`
puts a `float` in the path of money. In `user_version = 6` both tables gain
`costPerUnitCents INTEGER`, filled with `toCents(costPerUnit)`, and
`costForWeek` returns cents. The `REAL` column stays for the old screens until
they are rewritten, but **no money path reads it**.

---

## 2. What syncs and in which direction

`↑` the phone pushes · `↓` the phone receives · `↕` both · `—` does not travel.

| Phone table | Server table | Dir. | Rule |
|---|---|---|---|
| `people` | `employees` | ↕ | The phone registers people in the field. Fields that only exist on the web (photo, phone, address) arrive via `↓` and the phone does not stamp on them: push sends **only the fields the phone's screen edits**. |
| `crops` | `plot_crops` (+ their `plots`) | ↓ | **Read-only on the phone.** §2.1 |
| `pickups` | `work_records` (`pay_scheme='unidad_trabajo'`) | ↕ | The phone pushes weighings; it receives the work-unit work records the web recorded. Contract and time work records **do not come down to the phone** in the first version. §2.2 |
| `config` | `farm_config`, `farms` | ↓ | Name, crop, unit, timezone, currency, general price. The phone no longer edits them. |
| `config.language` | — | — | A device preference. Never travels. |
| `cost_overrides` | `week_prices` | ↓ | **Read-only on the phone.** §2.1 |
| `settlements` | `settlements` | ↓ | Created by the server and only by the server. §6 |
| `settlement_items` | `settlement_items` | ↓ | Same. They always arrive with their settlement, in the same batch. |
| `ledger` `pago`/`anticipo`/`deduccion`/`ajuste`/`reverso` | `ledger` | ↕ | A movement is a fact: it is pushed and it is accepted. §2.3 |
| `ledger` `devengo` | `ledger` | ↓ | Produced by `POST /v1/settlements`. The phone cannot write one. |
| balances, `BALANCE_SQL` | — | — | Derived. Recomputed on both sides. A total never travels. |
| IRL, anomalies, performance, week/plot/worker reports | — | — | Derived from the above. They never travel. |
| `demo`, `seed`, `clear` | — | — | Never. A `seed` over a synced farm is a catastrophe with a button on it. The screen hides itself once the phone is paired. |

### 2.1 Why prices and plots are read-only

They are the two inputs whose editing changes money **backwards and for
everybody at once**.

A weekly price edited in two places with "last write wins" reprices the farm's
entire week; there is no conflict to resolve because there is no disputed row,
there is a payroll. A single writer — the owner, on the web, where
`p_week_prices_write` already requires the `owner` role — removes the whole
class of error.

Plots are worse. `POST /v1/pickups` translates `cropId → plot_crop` and that
translation is 1:1 and deterministic **only while a plot has one crop**. If the
phone can invent plots with no signal, two weighers create "Lote 1" and "lote 1"
on the same day, and no automatic merge can know afterwards whether they were
the same one. Merging plots is the owner's manual work with a screen, not a
script's guess.

**What is lost, said plainly:** today the phone can create a plot and change the
week's price with no signal, and after this it cannot. It is a real product loss
and it is in §10 for the owner to sign off.

### 2.2 The work records the phone does not understand

By decision 3 the web already records contract and time work records. The phone
has no screen for that and is not getting one in this delivery.

**They are not sent to it.** The pull filters `pay_scheme = 'unidad_trabajo'`,
just like the `/v1/pickups` facade. A day's work on a screen that only knows how
to show kilos is worse than nothing — which is exactly what
`GET /v1/pickups/{id}` already decided by returning 404 for a work record that
is not by unit of work.

A consequence that has to be stated: **the phone cannot show the full balance of
a worker who also did day work.** Its local `BALANCE_SQL` will sum only the
movements it knows about. And that is why the phone's balance stops being the
truth: the balance screen moves to showing the balance that came from the server
(§3.3, `balances` in the feed) with the mark of when it arrived, and the locally
derived balance is used only while there are unpushed things, labelled
«provisional» (*provisional*).

### 2.3 Why outgoing money is pushed, and unconditionally

A `pago`, an `anticipo` or a `deduccion` is a fact: somebody handed over cash.
Refusing its arrival does not undo the fact, it only makes the database lie.

So the sync channel pushes ledger movements **and the server accepts them
without checking the balance**. Concretely: the `AMOUNT_EXCEEDS_BALANCE`
validation on `POST /v1/payments` is a defence against a fat-fingered entry on
the web's payment screen, and it is correct there. On the sync channel it
behaves as `allowOverpayment: true`, which is exactly what the phone does today
and what golden case 07 (`pago-mayor-al-saldo`) fixes: the balance goes negative
and the excess behaves as an `anticipo`. The balance is not clipped.

This does not open the door to double payment. A payment claims no weighing,
takes no lock, and two payments duplicated by human error are visible at a
glance in the worker's history — which is a people problem, not a merge problem.

---

## 3. The mechanism

A change feed with a per-farm sequence. The phone carries **a single number**:
`sync_state.cursor`. What it is missing is "everything with a `seq` greater than
that number".

It is not push/pull with a per-table watermark. A per-table watermark forces
`updated_at` everywhere, cannot tell a delete from a row that never existed, and
breaks on clocks: two rows written in the same millisecond, one before and one
after the cut, and one of the two is never seen again. A sequence is an integer
that only goes up and that a single server hands out.

### 3.1 `POST /v1/sync/handshake`

The first thing the phone does when pairing, and on every app start.

```jsonc
// →
{ "deviceId": "0192f0…",          // device uuid, stable, generated once
  "appVersion": "1.7.0",
  "schemaVersion": 6,
  "cursor": 148213 }              // 0 the first time

// ← 200
{ "farmId": "0192e1…",
  "timezone": "America/Bogota",   // with this the phone computes localDay and week
  "currency": "COP", "minorUnit": 2,
  "serverTime": "2026-08-29T14:02:11Z",
  "cursor": 149004,               // where the server is now
  "behind": 791,                  // how many changes the phone is missing
  "role": "weigher",              // what this token can do
  "capabilities": {               // what the app should enable or hide
    "settleOffline": false,
    "writePlots": false,
    "writeWeekPrices": false
  } }
```

`capabilities` is not a courtesy: it is what switches buttons off in the app
without having to ship a version when §10 changes its mind. And it does not
replace authorisation: the server still returns 403 even if the button is
visible, because hiding a button is not a permission.

**409 `SCHEMA_TOO_OLD`** if `schemaVersion < 6`: the phone knows it has to update
before touching anything and does not push a single byte.

### 3.2 `POST /v1/sync/push`

An ordered batch of envelopes. The order is local insertion order (`rowid`),
which is causal order: a parent was always inserted before its child.

```jsonc
// →
{ "deviceId": "0192f0…",
  "ops": [
    { "opId": "0192f1a0-…",       // envelope uuid. THE IDEMPOTENCY KEY.
      "entity": "worker",
      "op": "upsert",
      "payload": { "id": "0192e5…", "name": "Ana", "lastName": "Rodríguez",
                   "documentType": "CC", "docId": "1098…", "tag": "17",
                   "createdAt": "2026-08-20T13:02:00Z", "deletedAt": null } },

    { "opId": "0192f1a1-…",
      "entity": "workRecord",
      "op": "upsert",
      "payload": { "id": "0192e6…", "workerId": "0192e5…",
                   "cropId": "0192e2…",          // plot_crop
                   "quantity": 12.5,
                   "occurredAt": "2026-08-24T19:30:00-05:00",   // INSTANT with offset
                   "note": null, "deviceId": "0192f0…", "deletedAt": null } },

    { "opId": "0192f1a2-…",
      "entity": "ledgerEntry",
      "op": "append",
      "payload": { "id": "0192e7…", "workerId": "0192e5…", "kind": "anticipo",
                   "amountCents": 5000000, "date": "2026-08-24",
                   "method": "efectivo", "note": "adelanto en el lote" } }
  ] }
```

```jsonc
// ← 200  (always 200: each op's status is on its own row)
{ "cursor": 149006,               // the phone can carry on pulling from here
  "results": [
    { "opId": "0192f1a0-…", "status": "applied",   "id": "0192e5…" },
    { "opId": "0192f1a1-…", "status": "duplicate", "id": "0192e6…" },
    { "opId": "0192f1a2-…", "status": "rejected",
      "error": { "code": "WORK_RECORD_SETTLED",
                 "message": "…",
                 "details": { "settlementId": "0192d0…" } } }
  ] }
```

Push rules, all mandatory:

- **Every op runs in its own `SAVEPOINT`.** One rejection does not bring the
  batch down. A batch of 200 weighings where one points at a worker the web
  deleted has to get the other 199 in.
- **Maximum size 200 ops or 1 MB.** The phone chunks. On a farm's network, a big
  batch is a batch that never finishes.
- **The instant travels with its offset (`occurredAt`), never a bare day.**
  `local_day` is written by the server's trigger with the farm's zone, and Go
  never writes it. It is the same agreement that makes case 04 come out right on
  both sides.
- **`op: "append"` for the ledger, `op: "upsert"` for everything else.** There is
  no `op: "delete"`: a delete is an `upsert` with `deletedAt`. There is no
  physical delete in either direction.
- The phone **does not delete its outbox row out of optimism**: only when that
  `opId`'s `result` comes back as `applied`, `duplicate` or `rejected`.

### 3.3 `GET /v1/sync/pull?cursor=149006&limit=500`

```jsonc
// ← 200
{ "changes": [
    { "seq": 149007, "entity": "weekPrice", "op": "upsert",
      "row": { "weekStart": "2026-08-24", "priceCents": 95000 } },
    { "seq": 149008, "entity": "settlement", "op": "upsert",
      "row": { "id": "0192d1…", "workerId": "0192e5…",
               "periodStart": "2026-08-17", "periodEnd": "2026-08-30",
               "grossCents": 1187500, "status": "open",
               "createdAt": "2026-08-29T10:04:00Z", "voidedAt": null,
               "items": [ { "id": "0192d2…", "payableId": "0192e6…",
                            "weekStart": "2026-08-24", "quantity": 12.5,
                            "priceCents": 95000, "amountCents": 1187500,
                            "voidedAt": null } ] } },
    { "seq": 149009, "entity": "ledgerEntry", "op": "append",
      "row": { "id": "0192d3…", "workerId": "0192e5…", "kind": "devengo",
               "amountCents": 1187500, "date": "2026-08-29",
               "settlementId": "0192d1…", "reversesId": null } }
  ],
  "cursor": 149009,
  "more": false,
  "balances": [ { "workerId": "0192e5…", "balanceCents": 1187500 } ] }
```

- **A settlement travels whole, with its lines.** Never a header without its
  rows: a $1,187,500 document with nothing underneath it is exactly what the
  phone's `user_version = 4` migration existed to fix.
- `balances` is a **checksum, not data**. The phone recomputes the balance with
  its own `BALANCE_SQL` and compares. If they differ, it does not copy the
  server's number: it flags the worker and surfaces them on the §7 screen. A
  balance that arrives down the wire and gets stored is the materialised total
  this design has spent three documents rejecting. It only arrives in the last
  batch (`more:false`), once the phone is up to date.
- The phone applies changes **in `seq` order, in one transaction per batch**, and
  only then advances its cursor. A cut halfway leaves the cursor where it was
  and the batch repeats: applying an upsert twice by UUID is a no-op.

### 3.4 The feed, from the inside

```sql
-- +goose Up
CREATE TABLE sync_log (
  seq     bigserial PRIMARY KEY,
  farm_id uuid   NOT NULL REFERENCES farms(id),
  entity  text   NOT NULL,
  row_id  uuid   NOT NULL,
  op      text   NOT NULL CHECK (op IN ('upsert','append')),
  -- The transaction that wrote this row. It is what closes the hole that a
  -- bare sequence leaves: nextval() hands out numbers BEFORE commit, so a
  -- reader can see seq 100 committed while seq 99 is still in flight, take
  -- cursor 100, and never see 99 again. See the horizon below.
  xact    xid8   NOT NULL DEFAULT pg_current_xact_id(),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_log_farm ON sync_log (farm_id, seq);
CREATE UNIQUE INDEX ux_sync_log_row ON sync_log (farm_id, entity, row_id, seq);
```

It is written by `AFTER INSERT OR UPDATE` triggers on `employees`, `plots`,
`plot_crops`, `work_records`, `week_prices`, `farm_config`, `settlements`,
`settlement_items` and `ledger`. Triggers and not Go code, for the same reason
as `local_day`: a row written through a route nobody foresaw also has to appear
in the feed.

The pull query, with the horizon:

```sql
-- The horizon: the lowest seq still owned by a transaction that may not have
-- committed. Everything strictly below it is final, in order, for ever.
WITH h AS (
  SELECT COALESCE(MIN(seq),
                  (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log WHERE farm_id = current_farm()))
    AS horizon
    FROM sync_log
   WHERE farm_id = current_farm()
     AND seq > $1
     AND xact >= pg_snapshot_xmin(pg_current_snapshot())
)
SELECT s.seq, s.entity, s.row_id, s.op
  FROM sync_log s, h
 WHERE s.farm_id = current_farm()
   AND s.seq > $1
   AND s.seq < h.horizon
 ORDER BY s.seq
 LIMIT $2;
```

A row held back by the horizon is not lost: it appears in the next poll, in its
place. What the horizon guarantees is that **the cursor never jumps over a
change**, which is the one property that makes "a single number" sufficient.

The feed row carries only the identity; the body is composed at pull time by
reading the real table. That way a row corrected five times is sent once, in its
current state, and the feed is not a second copy of the money that could diverge
from the first.

**Retention:** `sync_log` is pruned to 180 days. A phone whose cursor is older
than the lowest retained one gets `409 CURSOR_TOO_OLD` and does a **bootstrap**:
`GET /v1/sync/bootstrap`, which returns the farm's full state, paginated, and a
new cursor. It is slow and it never happens, and that is why it exists.

### 3.5 When it syncs

On opening the app, on returning to the foreground, every 15 minutes when there
is a network, on tapping the §7 chip, and **always before opening any money
screen**. No websockets and no push notifications: the farm has a signal at the
house in the evening, the weigher does not have one out at the plot, and a
persistent connection over that network is battery spent for nothing.

---

## 4. Idempotency and retries

The network drops halfway. That is the normal case, not the exceptional one.
Re-sending has to be safe, and it is, through **three independent layers**, each
sufficient for a different kind of failure.

### 4.1 Layer 1 — identity belongs to the client

Every row carries a UUIDv7 generated on the phone before it touches the network.
The server's write is, without exception:

```sql
INSERT INTO work_records (id, farm_id, …) VALUES ($1, $2, …)
ON CONFLICT (id) DO NOTHING
RETURNING …;
-- Zero rows returned => it was already there => status "duplicate" and the same resource.
```

This covers the most common failure: the request arrived, the server wrote, the
response was lost. The phone re-sends, the `ON CONFLICT` does nothing, and the
phone gets back the row that already existed. **A retry cannot create a second
weighing because it cannot invent a second UUID: the UUID was generated when the
button was pressed, not when the request was sent.**

### 4.2 Layer 2 — the operation log

```sql
CREATE TABLE sync_ops (
  op_id     uuid PRIMARY KEY,
  farm_id   uuid NOT NULL REFERENCES farms(id),
  device_id uuid NOT NULL,
  status    text NOT NULL CHECK (status IN ('applied','duplicate','rejected')),
  result    jsonb NOT NULL,      -- the exact response that was returned
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_ops_device ON sync_ops (farm_id, device_id, at DESC);
```

Before applying an envelope, the server looks in `sync_ops`. If the `opId` is
there, it returns `result` **literally**, without executing anything again. This
covers the failure layer 1 does not: operations that are not the insert of a row
with its own UUID — voiding, reversing — and whose second attempt would have a
different outcome from the first.

`sync_ops` retention: 30 days. A retry after 30 days is not a retry.

### 4.3 Layer 3 — the semantics are already idempotent, and that is the good one

This is where the append-only ledger pays back what it cost. The system's
operations come in three classes and none of them needs "resolving":

- **Appending a fact** (weighing, `pago`, `anticipo`, `deduccion`, `ajuste`).
  Appending commutes. Two devices that both appended merge by taking the union.
  There is no merge, there is a `UNION`.
- **Taking a lock that can only be taken once.** The second attempt collides
  with a unique index and returns a 409 **that means "already done"**:
  `PAYABLE_ALREADY_CLAIMED` with the winning settlement, `ALREADY_REVERSED`,
  `SETTLEMENT_ALREADY_VOID`. The client treats them as success, not as errors.
- **Deriving a total.** Never transmitted. Recomputed.

That is why the table of client behaviour per code is short and has no ambiguous
cell:

| Response | What the phone does |
|---|---|
| `applied` / `duplicate` | Mark the op sent. Delete the outbox row. |
| `PAYABLE_ALREADY_CLAIMED` | Success. Store `details.winningSettlement` and wait for it to come down the feed. |
| `ALREADY_REVERSED`, `SETTLEMENT_ALREADY_VOID` | Success. Delete from the outbox. |
| `WORK_RECORD_SETTLED` | **Conflict.** To the §7 screen. Not retried. |
| `NOT_FOUND` (absent parent) | Retry once in the next batch; if it comes back, conflict. |
| `BAD_REQUEST` | Client bug. Never retried — a retry loop against a 400 is how an app eats a battery and a data plan. It is recorded and sent up to the log. |
| `401`, `403` | Refresh the token; if it comes back, stop syncing and warn. |
| `429`, `5xx`, timeout, no network | Retry with exponential backoff: 2s, 4s, 8s… up to 15 min, with jitter. No attempt limit: the phone has all the time in the world and the data does not expire. |

### 4.4 The bug that has to be fixed before switching anything on

`store.AddLedgerEntry` does a bare `INSERT` with no `ON CONFLICT`. Re-sending a
payment with the same `id` after a timeout does not return 200 with the existing
movement: it collides with the PK and comes out as a server error. That
contradicts the convention `openapi.yaml` itself declares in its header and
**breaks layer 1 in exactly the money table**.

```go
// store/money.go — AddLedgerEntry
// A retry after a lost response must return the movement that already exists,
// not a unique violation. This is the one write where the phone's idempotency
// guarantee was missing.
INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
                    method, note, created_by)
VALUES ($1, …)
ON CONFLICT (id) DO NOTHING
RETURNING …
-- 0 rows => SELECT the existing one and return 200 instead of 201.
```

The same in `POST /v1/payments|advances|deductions|adjustments`: if the `id`
already exists, `200` with the existing row. It is a three-line change per
handler plus a contract test that pins it. **Without this, push is not switched
on.**

---

## 5. The conflicts, one by one

Not in the abstract. Each with its winner and its reason.

### 5.1 Two devices record the same weighing

**It is not a conflict. They are two weighings.**

Each phone generated a different UUID, both go in, both get paid. A row's
identity is its UUID and **nothing else**: it is never deduplicated by
`(person, plot, weight, minute)`, because two pickers really do weigh 12.5 kg on
the same plot in the same minute, and a merge that decides they were the same
steals a day's pay from somebody without leaving a trace.

What does happen is that if it really was human error — the weigher wrote it
down twice — that is a duplicate, and `RULE_DUPLICATE_SQL` already exists for
it. It is ported to the server and now runs over the **merged** set, which is
where it can see it for the first time. It shows up on the review screen as a
suspicion, with two buttons, and a person decides.

The only case that does get deduplicated is the same device re-sending: same
UUID, `ON CONFLICT DO NOTHING`.

### 5.2 The phone settles a week the server has already settled

**Under §6 this cannot happen**, because the phone does not create settlements
without having synced and it creates them by calling the server. What remains,
for completeness, is two web users settling at the same time, and the transition
period before phase 6 of §8.

**The winner is whoever committed first in Postgres.** Not whoever asked first,
not whoever has the faster clock: whoever won the race on
`ux_items_payable_live`. The loser gets:

```jsonc
409 { "error": { "code": "PAYABLE_ALREADY_CLAIMED",
                 "details": { "payableId": "0192e6…",
                              "winningSettlement": { "id": "0192d1…",
                                                     "grossCents": 1187500,
                                                     "createdAt": "…" } } } }
```

and the reason the winner is the lock and not a rule of ours is that the lock is
the only thing that cannot get it wrong: it is the same transaction that writes.
Any arbitration in Go is a `SELECT` followed by an `INSERT`, and the other
settlement fits between them.

### 5.3 A weighing arrives late, from a week already settled

**It is not a conflict and nothing needs doing. It is already solved and there is
a golden case that pins it** (09, `pesada-tardia-de-semana-ya-liquidada`).

`PENDING_SQL` selects **by payable id, not by date**:

```sql
AND pk.id NOT IN (SELECT pickupId FROM settlement_items WHERE voidedAt IS NULL)
```

A weighing that arrives late is simply unclaimed, so it goes into the next
settlement, **at its own week's price** (the `week_prices` of its Monday, not the
settlement's Monday). The settlement already issued is not reopened, not
recalculated and not corrected: the receipt the worker is holding is still true.

**No closed settlement is ever reopened, for any reason.** If one has to change,
it is voided and redone, which is what case 05 does.

### 5.4 Somebody voids on the web a settlement the phone still believes is live

**The server wins, always, and there is nothing to ask.**

Voiding does not delete: it marks `settlement_items.voided_at` — which is what
releases the lock — sets `settlements.status = 'void'`, and posts a `reverso` of
the `devengo`. All three come down the feed in the same batch, the phone applies
them, and its balance re-derives on its own.

What matters is what **does not** happen: the `pago` the weigher already made
against that settlement **is not touched**. It stays in the ledger, with its
negative sign. The result is that the worker ends up owing what they collected,
which is exactly golden case 05 and exactly right: the farm gave them money and
the settlement that justified it no longer exists.

No conflict screen is needed. What is needed is a notice on the worker's page
with the three figures: what was voided, what was paid, what is now owed.

### 5.5 The week's price changed between the phone settling and syncing

**Under §6 the phone does not settle without a signal, so the price is applied
once, on the server, at settlement time.** The case reduces to another one: the
screen showed a preview and the real amount came out different.

That can happen, in seconds, if the owner changes the price from the web while
the administrator is looking at the settle screen. And a settlement that comes
out at a different amount from the one the person read before pressing the
button is unacceptable, because that person is about to count out that cash.

**Mandatory contract change:** `SettlementInput` gains an optional field.

```yaml
    SettlementInput:
      properties:
        expectedGrossCents:
          type: integer
          format: int64
          description: |
            What the caller was shown by /v1/settlements/preview. If the
            settlement would not add up to this, the server writes nothing and
            answers 409 GROSS_CHANGED with the new figure. A settlement that
            comes out to a different number than the one the person read before
            pressing the button is a number they are about to count out in cash.
```

and a new code, `GROSS_CHANGED`, with
`details: { expectedCents, actualCents, changedWeeks: ["2026-08-24"] }`.

The app **always** sends it. The screen shows both figures and the week that
changed, and the operator confirms or cancels. A price is not chosen
automatically: the new price may be a correction or a fat-fingered entry, and
the server cannot know which.

### 5.6 An employee deleted on the web has new weighings from the phone

**The weighing goes in. The employee stays deleted. Neither rejected nor
resurrected.**

The delete is soft (`employees.deleted_at`), so the composite FK still resolves
and the `work_record` `INSERT` works without touching anything. Both alternatives
are worse: rejecting loses work that really happened, and resurrecting silently
overwrites a decision the owner made.

The money keeps working: `BALANCE_SQL` does not look at `deleted_at`, and
`BalanceRow` already carries `inactive` precisely for this — *"Money is never
hidden, only marked"*. The worker gets paid.

The pair (new weighing, deleted employee) shows up on the §7 screen as
«Registraste trabajo de alguien que fue dado de baja» (*you recorded work for
somebody who was deleted*), with two buttons: **Volver a darlo de alta**
(*reinstate them*) and **Era otra persona** (*it was somebody else*).

**The real danger is somewhere else**, and it has to be plugged:
`ux_employees_doc` is partial, `WHERE deleted_at IS NULL`. After deleting Juan,
the web can create a second Juan with the same *cédula*. Then there are two
employees, the phone points at the old one, and one person's balance ends up
split across two records with nothing warning anybody. Merging them afterwards
is manual surgery on the ledger.

**Mandatory change:** `POST /v1/workers` with a `(documentType, docId)` matching
a deleted employee answers `409 EMPLOYEE_EXISTS_DELETED` with
`details.employeeId`, and the web offers to restore them instead of creating
another. It is one extra `SELECT` on a create, and it avoids the only conflict in
this document that has no automatic fix.

### 5.7 The four that were not on the list and bite just as hard

**(a) A weighing edited with no signal that the server has already settled.** The
phone has `pickups.setWeight` with its `isSettled`; the server returns
`409 WORK_RECORD_SETTLED`. The server wins. The phone **keeps the change as a
pending correction and shows it** — it does not discard it and does not apply it
— with the wording in §7. Voiding the settlement is not a button on that screen:
it is an owner's decision, on a screen that shows what voiding costs.

**(b) A weighing deleted with no signal that the server has already settled.**
Identical. The local delete is reverted when the pull is applied, and the attempt
stays as a conflict.

**(c) Two phones with clocks days out.** The merge order is the server's `seq`
and nothing else. What the app shows as the date is the instant the device
recorded, and the business day is computed by the trigger with the farm's zone.
A weighing with `occurredAt` in the future **is accepted** and flagged by
`RULE_FUTURE_SQL`: rejecting it at the boundary loses real work because of a
badly set clock, which is the wrong problem.

**(d) A weighing points at a crop the web deleted.** `plot_crops` has
`deleted_at` and the FK still resolves. It goes in. Not a conflict. The day a
plot has two crops, the `/v1/pickups` facade can no longer translate `cropId` and
the phone **has** to already be on `/v1/work-records`; that is not a sync
conflict, it is the deadline in §8.

---

## 6. The lock

### 6.1 The decision

> **The server owns the lock. The phone does not create settlements. A
> settlement is requested with `POST /v1/settlements`, online, with the cursor
> up to date. Cash handed over out at the plot with no signal is recorded as an
> `anticipo`.**

`ux_items_payable_live` in Postgres is the only lock that decides. The phone's
local lock, `ux_items_pickup_live`, stays — it protects imported settlements and
the ones that come down the feed from being claimed by a second one — but it
stops being what creates them.

The settle screen requires two things before enabling the button: a `pull`
completed in the current session (`more:false`) and an empty outbox for that
worker. If either is missing, the button is off with this sentence, and with the
`anticipo` button **next to it, not in another menu**:

> Para liquidar hay que sincronizar. Sin señal puedes entregar un anticipo: se
> descuenta solo cuando se liquide.

(*To settle you have to sync. With no signal you can hand over an `anticipo`: it
is deducted automatically when the settlement happens.*)

### 6.2 Why the `anticipo` genuinely solves working without a signal

This is not a consolation prize, it is the technically correct answer.

An `anticipo` **claims no weighing**. It does not touch `settlement_items`, takes
no lock, and so two devices recording advances with no signal merge by union
with no possibility of conflict. And it is not an accounting bodge: when the
settlement arrives, the positive `devengo` adds to the negative `anticipo` in the
same `SUM(amount_minor)` and the balance comes out exact. That is what golden
case 02, `anticipo-mayor-que-la-semana`, pins: an advance larger than the week
amortises across several, with the balance checked week by week.

The weigher hands over cash at the plot, prints an `anticipo` receipt, and the
worker sees their balance go down. The only thing they cannot do without a
signal is **close** the week and issue the definitive document — and closing a
week is an office act, not a plot act.

### 6.3 What each option loses, the chosen one included

| | What it does | What is lost |
|---|---|---|
| **A. Server owns it (chosen)** | The phone does not settle without syncing; the `anticipo` is the way out in the field | Closing a week and issuing the definitive receipt with no signal. **The app does it today and will stop.** Mitigated: the `anticipo` also prints a receipt, and the later settlement amortises it to the cent. |
| **B. Settle offline and arbitrate on arrival** (what `sync-and-roles.md` proposes) | The phone settles; the server rejects the loser and sends them the winner to re-derive | **The loser's cash is already in the picker's pocket.** A settlement has to be undone after the money moved — which is literally the failure this whole system exists to avoid. And the loser is the one who had no signal, i.e. the weigher, i.e. the one least able to fix it. |
| **C. Reservation with a lease** | While online the phone reserves a set of payables and can settle them offline until the lease expires | Real complexity (expiry, renewal, releasing after a lost phone) in exchange for something that **only works if the phone was online recently** — which is exactly when A works too. And a phone that falls in the river leaves weighings locked until the lease expires. |
| **D. Lock split per device** | Each device can only settle what it recorded | Breaks the guarantee of **one** settlement per worker: somebody who picked with two weighers gets two documents and two receipts. It is exactly the two-payable-tables problem `arquitectura-api.md` §1 rejected, reintroduced through the back door. |

The argument that decides between A and B is not technical, it is about who does
what. **The one who spends days without a signal is the weigher, and the weigher
does not settle:** the RLS policies `p_ledger`, `p_settlements` and
`p_settlement_items` already deny him money entirely. The one who settles is the
owner or the administrator, and they do come down to the house, the cooperative
or the town. We are asking for a signal from precisely the person who has one.

### 6.4 And if the owner will not give up offline settlement

Then the answer is **not** B. It is: offline settlement stays, is marked
`provisional`, prints a receipt that says «provisional» in large letters, and
**cannot be paid against until it syncs**. A `pago` with the `settlementId` of a
provisional settlement is blocked on the phone. That keeps the workflow and
moves the restriction from where it does not hurt — recording — to where it does
matter — handing over the cash. It is more code and one more screen, and it is
the only variant of B that cannot pay twice.

---

## 7. What the user sees

The principle: **the weighing screen never blocks, and no conflict closes
without a decision.** A conflicts screen nobody understands is useless, and one
nobody can close is worse.

### 7.1 The status chip

One, in the header, always visible, tappable. Four states and none of them is a
bare spinner:

| State | Text | Colour |
|---|---|---|
| Up to date | «Sincronizado · hace 3 min» (*synced · 3 min ago*) | neutral |
| Pending | «12 sin enviar» (*12 unsent*) | neutral |
| No network | «Sin señal · 12 pendientes» (*no signal · 12 pending*) | amber |
| Conflict | «3 necesitan tu decisión» (*3 need your decision*) | red, and only this one is red |

Tapping it opens the detail: how many weighings, how many payments, since when,
and a «Sincronizar ahora» (*sync now*) button. **The pending count is not
decoration**: it is what an owner looks at before leaving the plot.

### 7.2 What has not been sent

A small dot on the row, in the lists that already have rows: recent weighings,
a worker's movements. No modals, no banners, no blocking. Next to the dot, on
the detail, one line: «Pendiente de enviar» (*pending send*). And nothing more:
an unsent weighing is a perfectly good weighing.

### 7.3 The conflicts screen

One card per problem. Every card **has to carry a person, a date and an amount
or a quantity** — a card with no name and no figure is not a card, it is noise,
and it comes out of the design.

The cards below are the Spanish interface, as the picker's supervisor reads
them; the English gloss follows each one.

```
┌──────────────────────────────────────────────┐
│ Ana Rodríguez · martes 25 de agosto          │
│                                              │
│ Cambiaste esta pesada de 12,5 kg a 13,0 kg,  │
│ pero ya se pagó en la liquidación del 26 de  │
│ agosto, por $1.187.500.                      │
│                                              │
│ [ Ver la liquidación ]  [ Descartar mi cambio ]│
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Juan Pérez · 3 pesadas, 41,2 kg              │
│                                              │
│ Registraste trabajo suyo, pero fue dado de   │
│ baja en la web el 20 de agosto. El trabajo   │
│ quedó guardado y su saldo está correcto.     │
│                                              │
│ [ Volver a darlo de alta ]  [ Era otra persona ]│
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Ana Rodríguez · liquidación del 26 de agosto │
│                                              │
│ Esta liquidación se anuló desde la web el 29 │
│ de agosto. El pago de $1.187.500 que hiciste │
│ sigue en el historial, así que Ana queda     │
│ debiendo $1.187.500.                         │
│                                              │
│ [ Entendido ]  [ Ver el historial de Ana ]   │
└──────────────────────────────────────────────┘
```

In English: (1) *you changed this weighing from 12.5 kg to 13.0 kg, but it was
already paid in the settlement of 26 August, for $1,187,500* — buttons *see the
settlement* / *discard my change*. (2) *you recorded work for him, but he was
deleted on the web on 20 August. The work was saved and his balance is correct*
— buttons *reinstate them* / *it was somebody else*. (3) *this settlement was
voided from the web on 29 August. The $1,187,500 payment you made is still in
the history, so Ana now owes $1,187,500* — buttons *understood* / *see Ana's
history*.

Rules for that screen, non-negotiable:

- **At most two buttons.** If three are needed, one of them is an owner's
  decision and belongs somewhere else (voiding a settlement is the example).
- **Never a diff of two JSON blobs.** Never "local version / remote version".
  The farm does not think in versions, it thinks about Ana and about Tuesday.
- **Nothing auto-resolves or disappears on its own.** A card closes because
  somebody tapped, and it is recorded in the conflict history with who tapped
  what.
- **Money conflicts are not shown to the weigher.** The role already denies him
  them on the server; the screen filters by role and the weigher only gets his
  own: rejected weighings and deleted employees.

### 7.4 Balances, while there are unsent things

The worker's page shows the balance with a label when the phone is not up to
date:

> Saldo $340.000 · **provisional**, faltan 4 movimientos por enviar

(*Balance $340,000 · provisional, 4 movements still to send*)

and if the pull's `balances` (§3.3) does not match the local `BALANCE_SQL` with
everything sent and everything received, that is **not** fixed by copying the
number: a red card comes up with both figures and an «Enviar informe» (*send
report*) button. It is a calculation bug between two implementations of the same
money, and that is what the nine golden cases are for; it has to be found out,
not papered over.

---

## 8. The migration plan for the farm already using the app

Nine phases. **In none of them is there a moment where a payment could be lost
or duplicated**, and the structural reason is one: until phase 7 the phone keeps
its SQLite complete and correct, and nothing that is done modifies it
destructively.

Precondition: decision 3's mitigation still stands — **pay from one side only** —
until phase 7. Not until sync is deployed.

**Phase 0 · Before touching the phone.**
Fix §4.4 (ledger idempotency) and deploy it. Add `expectedGrossCents` and
`GROSS_CHANGED` (§5.5), and `EMPLOYEE_EXISTS_DELETED` (§5.6). All three are
server changes that affect nobody until somebody uses them.

**Phase 1 · A phone version that only adds columns.**
`user_version = 6`: the UUIDs, the backfill, `deletedAt` on `pickups`,
materialised `localDay`/`week`, `costPerUnitCents`, `outbox`, `sync_state`.
**Not one network call.** The app behaves exactly the same.
Exit criterion: the mobile app's 75 tests and the 9 golden cases green,
**run against a copy of the farm's real database**, not a seeded one.
`missing = 0` on the §1.3 query.

**Phase 2 · The backup.**
A copy of the phone's `.db` is taken to two separate places, and **restoring it
is tested** on a spare phone: the app is opened and three figures are compared
against the original's screen (season kilos, number of live settlements, balance
of the worker with the most movements). Nothing continues until that restore
works. A backup nobody has restored is not a backup.

**Phase 3 · The import, dry.**
Against a test database with the migrations applied, in **a single
transaction**, keeping the phone's UUIDs:

```sql
-- Order matters: parents first, and every id is the phone's own uuid.
--  people          -> employees
--  crops           -> plots (new uuid) + plot_crops (INHERITS the crop's uuid)
--  cost_overrides  -> week_prices
--  pickups         -> work_records, seed activity "Recolección",
--                     rate_source = 'weekly_price', unit = kg,
--                     started_at = pickups.date, quantity = weight
--  settlements     -> settlements
--  settlement_items-> settlement_items (payable_id = pickups.uuid)
--  ledger          -> ledger, in id order, with settlement_id and reverses_id
--                     resolved by uuid
```

`plot_crops` inherits the `crop`'s uuid because that is where the weighings
pointed; the plot is new and takes the name of the plot the user had in his
head. It is the migration `modelo-datos.md` §B already describes, and its
important property is that **the money is not remapped**:
`settlement_items.payable_id` points at the same uuid it pointed at on the phone.

And before the `COMMIT`, three reconciliation queries that **must return zero
rows**:

```sql
-- 1. Balance per worker: the phone's against the server's.
--    Any row here aborts the transaction.
SELECT e.id, p.balance_cents, s.balance_minor
  FROM phone_balances p JOIN employees e ON e.id = p.uuid
  JOIN LATERAL (SELECT COALESCE(SUM(amount_minor),0) AS balance_minor
                  FROM ledger WHERE employee_id = e.id) s ON true
 WHERE p.balance_cents <> s.balance_minor;

-- 2. Kilos per week.
SELECT week_start, SUM(quantity) FROM work_records GROUP BY 1
EXCEPT SELECT week, kg FROM phone_weeks;

-- 3. The lock: as many live lines as the phone had, not one more.
SELECT COUNT(*) FROM settlement_items WHERE voided_at IS NULL;  -- = phone count
```

Repeated until it comes out clean. All of this happens on a copy: the phone
knows nothing about it.

**Phase 4 · The cutover, and it is the only hour that matters.**
A Tuesday morning, a day the farm does not pay, with somebody present:

1. The phone's app goes into **money read-only mode** by remote control
   (`capabilities.settleOffline = false` plus a `moneyReadOnly = true` in the
   handshake, or a local flag if there is still no network): weighings can be
   recorded, settling, paying and voiding cannot. Recording stays open because
   the cutover cannot stop the scale.
2. A second backup is taken, the real one, the one from the moment of the cut.
3. The phase 3 import is run against production, with the same three
   reconciliation queries **inside the transaction**.
4. If anything fails: `ROLLBACK`, read-only mode is lifted, and the farm carries
   on as it was. **The phone has not been modified, so there is nothing to
   undo.** That is the entirety of this plan's safety.

Expected duration: under an hour for one season.

**Phase 5 · Pull only, 24 hours.**
`pull` is switched on and nothing else. The phone receives, applies and sends
nothing. During those 24 hours the phone and the web are looking at the same
thing from two places, and the phone's new weighings **still do not leave it** —
they sit in the outbox, waiting.

Compared by hand: five workers' balances, the week's kilos, the number of live
settlements. This is where a mistake is found for free, because nothing has yet
been written to the server from the phone.

**Phase 6 · Push.**
Push is switched on. The outbox drains in order. Reconciled again. The server
now has everything that happened during phase 5.

**Phase 7 · Read-only mode is lifted and the warning removed.**
The phone can pay and void again, with the settle button requiring a prior sync
(§6.1). **Here, and only here, the web's permanent warning is removed** and
decision 3's "pay from one side only" mitigation ends.

**Phase 8 · Keep.**
The pre-migration backup is kept for the whole season. It is not deleted the
next day, because a discrepancy is discovered when somebody complains, and that
happens three weeks later.

**Phase 9 · The deadline we did not set.**
The phone still talks over `/v1/pickups`, which translates `cropId → plot_crop`.
**The day the farm registers a second crop on a plot, the facade can no longer
translate.** Before that day the phone has to be on `/v1/work-records`. It is
not a calendar preference: it is a property of the model, and the web has to
prevent creating a second crop on a plot while there is a phone on
`schemaVersion < 7`.

---

## 9. What I would NOT do

- **CRDTs, automerge, or any merge library.** The ledger already commutes:
  appending is commutative and the balance is a `SUM`. A CRDT library adds
  nothing to that and inserts an algorithm nobody on the team can debug between
  a picker and his pay.
- **Last-write-wins on any money row.** There is not a single field on the money
  trail whose overwrite is safe. Where a correction is needed, it is voided and
  redone, which is the only operation that leaves a trace.
- **A generic bidirectional table replicator.** The per-table direction in §2
  *is* the design. A generic engine erases it and turns the first misconfigured
  setting into a payroll leak.
- **Vector clocks, HLC, or any distributed ordering.** There is one server. Its
  commit order is a total order. `sync-and-roles.md` proposed "a per-device
  counter plus arrival order"; the `seq` with a horizon does the same thing with
  one integer.
- **Websockets, SSE or push notifications.** Poll on open, on foreground, every
  15 minutes and on tap. A persistent connection over a farm's network is
  battery and data in exchange for latency nobody cares about.
- **Syncing anything derived.** Balances, IRL, anomalies, totals — not once.
  They are recomputed on both sides from the same facts, and if they differ that
  is a bug the golden cases have to catch, not a row to copy. The only total
  that travels is the `balances` of §3.3, and it travels **as a checksum**, gets
  compared and gets thrown away.
- **Syncing prices and plots in both directions.** §2.1.
- **Physically deleting anything, in any direction.** A `DELETE` leaves no
  tombstone and resurrects on the next pull. That is why `pickups.remove`
  becomes soft in §1.5.
- **A conflicts screen with a diff.** §7.3.
- **Syncing photos in the first version.** An employee photo is megabytes out of
  the weigher's data plan. It uploads on wifi only, in the background, and
  **blocks nothing**: an employee with no photo is an employee.
- **Encrypting the local database, a separate sync process, or a native
  background service.** None of the three solves a problem this farm has today,
  and all three are code that has to be maintained without being able to test
  it.
- **Automatically resolving a conflict that touches money.** If the rule is not
  written in §5, it ends up in front of a person.
- **A "force upload" or "reset sync" mode in the interface.** It is the button
  somebody presses one day at eleven at night. If a bootstrap is needed, the
  server triggers it with `CURSOR_TOO_OLD`.

---

## 10. What only the owner can decide

Each of these changes what his people can do out at the plot. None of them can
be signed off by the team.

1. **The phone stops settling without a signal** (§6). In the field an
   `anticipo` is handed over, and it amortises exactly. Is losing the week's
   close out at the plot acceptable? If not, the "provisional" variant of §6.4
   has to be built, which is one more screen and two more weeks.
2. **Plots and crops become read-only on the phone** (§2.1). Who opens a new
   plot mid-harvest, and can they wait for somebody to create it on the web?
3. **The weekly price becomes read-only on the phone** (§2.1). The owner sets it
   on the web. Does that work for him?
4. **The phone will not see day work or contracts** (§2.2), so its balance stops
   being the full balance for anyone who does both. Accepted, or does the mobile
   work-records screen have to be costed before sync?
5. **A phone that has gone many days without syncing: does it still get to
   weigh?** Recommendation: **yes, always**, no limit. But that means an
   unbounded backlog and a large reconciliation the day it comes down. The
   alternative — blocking after N days — stops the scale, and stopping the scale
   is worse.
6. **A deleted worker with new work** (§5.6): is the default behaviour to
   reinstate them, or to leave them deleted and raise it? Recommendation: leave
   them deleted and raise it, because somebody decided that deletion.
7. **Who reads the conflicts screen.** Recommendation: the money ones, owner and
   administrator only; the weigher sees only his own. If the owner wants the
   weigher to see them all, reads have to be opened up that RLS denies him
   today, and that is a payroll privacy decision, not a sync decision.
8. **When the phase 4 cutover happens** and who is present. A Tuesday morning,
   under an hour, and not a pay day.
