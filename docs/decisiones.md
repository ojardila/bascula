# Owner decisions

The ones the team could not make on its own. Each closes a discussion left open
in the designs; if any of them changes, the schema or the contract changes with
it, so they are recorded here with their date and their consequence.

## 2026-08-28

### 1. Worker history across farms — periods and who looked, nothing else

The `registry` service gets built, but **it does not publish opinions**.

What is shared: that the *cédula* exists, at how many farms the person worked
and in which **months**. What never leaves the farm: notes, balances, debts,
advances, kilos, performance, phone, address, photo, or the names of the farms.

Every lookup is recorded with who made it and what for, and **the worker can
read that record**. If that screen does not get built, the registry does not get
switched on.

`employee_notes` is born with `visibility = 'private'` and has no route out. The
`employment_spans` table has no free-text column, no flag and no score: there is
nowhere to write a judgement about a person, and that is deliberate. The schema
is the defence, not a written policy somebody can step around.

The "safety alerts" of RSP-009 are out. A traffic light over a person, queryable
by *cédula* across a whole region, is a labour blacklist under another name, and
Law 1581 of 2012 would make the platform liable for it. A defensible version
does exist — facts from a closed catalogue, attributed, notified to the worker,
disputable and expiring at 24 months — and it can be built later, by a written
decision, not by switching on an `if` one Tuesday.

### 2. Farm signup — open self-registration

`POST /v1/signup` is public, with email verification and rate limiting. The farm
becomes active without anyone intervening.

The super-admin console stops being the front door and keeps only what it does
need: see the farms, suspend one, and nothing else. It still cannot read any
farm's employees, work records or money.

Consequence: public signup is the most exposed attack surface in the system. It
needs per-IP rate limiting, email verification before the first session, and a
cap on farms per email address.

### 3. The web records work records from sprint 1

We do not wait for sync. We accept that for a few weeks the phone and the server
will keep separate books.

The consequence, and it has to be said plainly: **until sync arrives, a work
record entered on the web does not exist for the phone, and vice versa.** Paying
someone from both sides in the same week pays them twice, because the
double-payment lock lives in each database separately.

Mitigation while it lasts: during the transition, **pay from one side only**.
The web shows a permanent warning until sync is in production.

### 4. Activity prices have a dated history

Just like the weekly picking price, which already works that way. Each activity
stores its prices with a validity date; a work record freezes the one in force
on its own date.

Consequence in the schema: `activity_pay_*` stops holding a loose price and
gains a validity table with `valid_from`, plus an index that forbids two
overlapping prices for the same activity. And a rule that was already in the
design becomes mandatory: a work record whose price is derived by date has to be
**for a single day**. A day's work running Tuesday to Tuesday has no single
validity date, and deriving a price over a range is exactly the ambiguity that
ends in a miscalculated payment.

## Still to be decided

- **The public repository of activities and products** (RSP-010, RSP-018): the
  use cases say they are pulled "from the internet", but that catalogue does not
  exist anywhere yet. Who maintains it?
- **RSP-022, RSP-023 and RSP-024** are missing from the use-case document.
- **Self-registration has no written use case.** RSP-033 is *Eliminar Gasto*
  (delete an expense); the "Registro de finca" section was left unnumbered and
  undetailed.

---

# Team decisions

The ones the team could make, recorded because they contradict something already
written in the designs.

## 2026-08-29 — Categories are catalogues, not enumerations

`arquitectura-api.md` fixed three activity categories and `modelo-datos.md`
declared four. Both were wrong: RSP-011 says the selector comes «con opción de
crear una nueva» (*with the option to create a new one*). A farm that also grows
cacao will invent categories nobody foresaw, and with a Postgres `ENUM` each one
of them would be an `ALTER TYPE` in production.

So `activity_categories` is a per-farm table, seeded on creation with the three
starters, and `SEED_ACTIVITY_CATEGORIES` in `packages/shared` is only that seed.
The same goes for everything the use cases describe with "add if it does not
exist": crop types, varieties, work units, product categories and storage units.

The ones that stay closed enumerations are the ones the code branches on, and
that mean nothing if a farm invents a value: `ledger_kind`, `pay_method`,
`farm_role`, `settlement_status`, `pay_scheme`, `time_unit` and `stock_reason`.

## 2026-08-29 — A work record is called `work_record`, and only that

The documents carried three names for the same entity: `arquitectura-api.md`
uses `/v1/tasks` in its Delivery 2 and `work_records` in revision 2, and
`modelo-datos.md` calls it `labors`. With that, the front end built against one
name and the back end was heading for another.

It is `work_records`: the table, the `/v1/work-records` endpoints, and
`payable_id` in `settlement_items` with the partial double-payment index intact.
`tasks` is too generic and collides with any kind of system task; `labors` in
English means something else. In the Spanish interface it is still called
«labor», which is the owner's word.

## 2026-08-29 — One React across the whole monorepo

The mobile app pins React to the version its Expo SDK ships. The web asked for a
range that resolved to a different one, and npm installed both. Two React
instances in the same process return null contexts and bring down any hook that
reads them: the web's tests were failing because of that, not because of their
own code.

The root `package.json` now pins `react` and `react-dom` with `overrides`. When
Expo moves version, that is the only place to touch.

## Pending before deploying: CORS

The API does not mount CORS, so a browser cannot call it from another origin. In
development the Vite proxy handles it, forwarding `/v1` and `/health`, and that
is fine while there are only laptops. Before deploying we have to choose: serve
the web and the API behind the same origin, or mount CORS on the server with an
allowlist of origins. The first is simpler and opens nothing; the second is
needed if the web is going to live on another domain.

---

## 2026-08-29 — Sync: the four that were missing

### 5. The phone stops settling without a signal

Out at the plot, cash is handed over as an `anticipo`, which is amortised to the
cent when the settlement happens. The week is closed with a signal, against the
server, which is the only owner of the double-payment lock.

This is not a retreat in disguise: an `anticipo` claims no weighing, so it takes
no lock, and two phones with no signal merge by union with no possibility of
conflict. Golden case 02 already demonstrates that an `anticipo` larger than the
week amortises against the following ones with the balance exact.

What it avoids is the opposite: with two locks, one in each database, paying
from the phone and from the web in the same week pays twice, and re-deriving
afterwards does not give back cash that has already left somebody's pocket.

### 6. Plots and the weekly price, on the web only

The phone reads them and does not change them. This prevents two people setting
different prices for the same week, which is the conflict that has no correct
answer: either price leaves somebody underpaid.

A cost to accept and say out loud: opening a new plot mid-harvest can no longer
be done from the plot. Somebody has to get to a computer.

### 7. The phone shows the full balance, even when it cannot itemise it

Once the web records day work and contracts, the phone will total everything the
person is owed, not only their picking, even though it can only break down the
weighings. A balance that counts half the work is a balance that lies, and
whoever reads it has no way of knowing.

### 8. A deleted worker with new work is reactivated automatically

If they went back to work, they are still at the farm. The team recommended the
opposite — leave them deleted and raise it, because somebody decided that
deletion — and the owner chose automatic reactivation.

A consequence that has to be covered: the reactivation **is recorded**, with the
work record that triggered it and the device it came from, so that whoever did
the deletion can see that it was undone and why. Silently undoing a person's
decision is the one thing that cannot happen here.

## 2026-08-29 — The five gaps that sync uncovered

Implementing the protocol turned up five cases it did not cover. None of them
was decided by the pair who found them, which is correct: they decide payments.

### The three the team closes

**A weighing arrives naming somebody the phone does not have.** The protocol
covers a *deleted* crop, not an *absent* one. An absent referent is not a
conflict, it is an incomplete pull: the phone asked for the weighings before the
people. Receiving is ordered so that referents come down first — farms, people,
plots, crops, activities, prices, and only then work records and movements — and
an orphaned weighing becomes a client error that is retried, not a row saved
pointing at nothing.

**A reactivated worker whom the web deletes again between two syncs.** The
deletion wins. Reactivation is automatic and the deletion is decided by a person
looking at the case; a later human decision cannot be undone by an automatism.
The recorded work is not lost — it stays, and the person stays inactive — and
the phone shows it as a conflict so somebody looks at it.

**`IDEMPOTENCY_KEY_REUSED` is not in the protocol's conflict table.** It is a
real server code and it means something precise: the same id with a different
body. It is not a retry and must not be retried — it is either a client
programming error or an identifier collision, and both have to be visible. It
goes into the table as a case that is shown and does not resolve itself.

### The two that are server work, and wait

**The phone still settles locally.** The protocol wants the settlement to be
created by the server, and the pair were right not to move it: the season of
settlements that already exists on the phone has not been imported, so a
settlement created on the server would claim weighings the server does not have.
The right order is to import first. Until then the button demands being in sync,
which is half the guarantee.

**The race between preview and settle is not protected.** The protocol asks the
client to send the gross it saw (`expectedGrossCents`) and the server to reject
the settlement if it has changed. That field does not exist yet. Without it,
somebody can settle looking at one figure and sign for another.

## Debt declared at the close of sprint 5

Things that were worked around honestly and have to be closed. None of them is
hidden: the screen shows that it is missing.

1. **`GET /v1/settlements` does not exist.** There is only `POST`. The console
   assembles the list by walking each employee's ledger via the `settlementId`
   on the `devengo`, which works and does not scale. The route is missing.
2. **`/v1/users` does not exist.** The screen for inviting somebody to the farm
   is built and states the routes it expects; today the only way to create a
   user is by registering a new farm.
3. **Automatic reactivation of a deleted worker with new work** — the owner's
   decision 8 — is not implemented on the server. Today the weighing goes in and
   the person stays deleted, which is the opposite of what was decided. And the
   audit record that was the condition for it being safe is missing too.
4. **The import timeout is 25 seconds**, and a season is 11.7 MB. On a farm's
   link that can fall short. A failure there loses no data — it is a response
   nobody read, and the retry is safe — but it should be raised before the real
   move.
5. **Pruning `sync_log` and `sync_ops`** is not scheduled. The side that detects
   it (`CURSOR_TOO_OLD`) does exist, so the day pruning starts, a badly
   out-of-date phone finds out instead of receiving an incomplete history.
