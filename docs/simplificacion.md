# The simplification the owner proposed

> "Do you think we are overcomplicating things with that sync model? Wouldn't it
> be better to handle balances only with what is on the web, and only record
> harvest pickings asynchronously?"

That is: **the phone stops owning the money.** It captures weighings and uploads
them; balances, settlements, payments and the ledger live only on the server.

This document does not offer an opinion on whether that "is cleaner". It sets
out what gets deleted, what gets lost, which audit findings disappear, how the
real farm moves across, and what the alternative would cost. The figures are
measured against `master` at `b539d08`, not estimated.

Status note as this is written: `master` is green (189/189 mobile tests, 85/85
in `packages/shared`, 334/334 on the web). The working tree has uncommitted
changes from another pair in `schema.ts` and `sqliteRepository.ts` that break 4
tests — `BALANCE_COLUMNS` is not imported in
`apps/mobile/src/data/sqliteRepository.ts`. Not this document's business, but
worth knowing.

---

## 0. Why the proposal is stronger than it looks, with the files open

The owner's decision 5 already took the phone's authority over money away: the
week is closed with a signal, against the server, and the cash handed over at
the plot is an `anticipo`. What was left in the code after that decision is
contradictory, and this is not a suspicion — it is what runs today:

1. `apps/mobile/src/screens/PayWorker.tsx:131` calls `payments.settle`, which
   writes `settlements`, `settlement_items` and the `devengo` into the phone's
   SQLite.
2. The outbox triggers (`apps/mobile/src/schema.ts`, `outboxTriggersSql` over
   `SYNCED_TABLES`, which includes `settlements` and `settlement_items`) queue
   those rows.
3. `apps/mobile/src/sync/engine.ts:421-426` sends them as a `readOnlyEnvelope`.
4. `services/api/internal/httpapi/handlers_sync.go:402-406` **rejects** them:
   *"settlements are created by POST /v1/settlements"*.
5. The `devengo` never even leaves:
   `apps/mobile/src/sync/restTransport.ts:475` marks it `unsendable` /
   `SERVER_OWNED`.
6. **But the `pago` does leave**, via `/v1/payments` with
   `allowOverpayment: true` (`restTransport.ts:458` and `:496`).

The result, from phase 6 of `sincronizacion.md` §8 onwards: the server receives
a payment without the `devengo` that justifies it, **and the weighings are still
unclaimed in `ux_items_payable_live`**, so the web can settle them again and pay
them again. That is the double payment the whole design exists to prevent,
coming in through the door decision 5 left half closed. It is not live today
only because decision 3's mitigation — "pay from one side only" — still stands.
The day that is lifted, it is live.

And there are two more holes in the same place, neither of which either option
can leave as it is:

- **Crew payroll has no sync guard at all.** `PayWorker.tsx:112` does require a
  fresh pull (`settleAllowed = !status.registered || fresh`).
  `PaymentsPanel.tsx:141` calls `Payments.runPayroll` **without checking
  anything**. The §6.1 rule protects the path for one worker and leaves the path
  for thirty wide open.
- **`capabilities.settleOffline` is decoded and thrown away.** Both transports
  parse it (`restTransport.ts:248`, `feedTransport.ts:167`) and **no screen
  reads it**. The "money read-only mode by remote control" that phase 4 of §8
  takes for granted does not exist.

The owner's proposal is, at bottom, pointing out that we built bidirectional
money sync **before** decision 5 and never went back to remove what had stopped
being necessary.

---

## 1. What exactly gets deleted, and what stays

### 1.1 What gets deleted — application code

Line ranges against `b539d08`.

| File | What | Lines |
|---|---|---|
| `apps/mobile/src/data/sqliteRepository.ts` | `pendingItems` 1108‑1136 (29) · `reverseHere` 1170‑1197 (28) · `voidSettlementHere` 1199‑1256 (58) | 115 |
| same file, inside `payments` | `preview` 1260‑1275 (16) · `settle` 1276‑1330 (55) · `voidSettlement` 1331‑1344 (14) · `runPayroll` 1345‑1401 (57) · `pay` 1402‑1415 (14) · `adjust` 1448‑1464 (17) · `reverse` 1465‑1495 (31) · `undoRun` 1496‑1526 (31) · `paidAgainst` 1606‑1609 (4) · `paidInRange` 1610‑1617 (8) · `pendingAll` 1637‑1689 (53) | 300 |
| same file | `balance` / `balances` / `fullBalance` 1527‑1597 (71) rewritten down to ~25 | −46 |
| `apps/mobile/src/schema.ts` | `BALANCE_SQL` 126‑160 (35 → ~6) · `PAID_AGAINST_SQL` 161‑187 (27) · `PAID_IN_RANGE_SQL` 188‑196 (9) · `PENDING_SQL` 197‑212 (16) · `ux_items_pickup_live` inside `PAYMENTS_SCHEMA` (4) | 85 |
| `apps/mobile/src/data/syncStore.ts` | `applySettlement` 399‑480 | 82 |
| `apps/mobile/src/sync/engine.ts` | `checkBalances` 615‑693 (79) · the `settlements`/`settlement_items` branches of `envelope` and `readOnlyEnvelope` (~30) | 109 |
| `apps/mobile/src/screens/PayWorker.tsx` | whole file | 406 |
| `apps/mobile/src/screens/PaymentsPanel.tsx` | whole file | 435 |
| `apps/mobile/src/screens/Account.tsx` | rewritten as read-only (393 → ~200) | 193 |
| `apps/mobile/src/screens/Adjust.tsx` | only the `anticipo` remains (172 → ~110) | 62 |
| `apps/mobile/src/receiptHtml.ts` | `payrollHtml` 181‑312 | 132 |
| `apps/mobile/src/data/repository.ts` | 14 of the 21 `PaymentsRepo` methods, and the types `SettlementPreview`, `PendingItem`, `PayrollRun`, `SettleResult`, `PendingWorker` | ~90 |
| **Total code** | | **≈ 1,963** |

To be written in exchange: an `anticipo` screen (~120), the balance-as-read card
with its timestamp (~60) and reading `server_balances` on the worker's page
(~40). **≈ 220.** Net: **−1,743 lines of code**.

The mobile app today is 23,418 lines of TS/TSX, of which 5,705 are tests. This
deletes **11 %** of its application code.

### 1.2 What gets deleted — tests

| File | What | Lines |
|---|---|---|
| `apps/mobile/src/data/repository.test.ts` | 27 of 52 tests (settle, void, payroll, undo, payroll sheet, `paidAgainst`) | 581 |
| `apps/mobile/src/ledger.test.ts` | 11 of 13; the file is left with no subject | 275 |
| `apps/mobile/src/sync/sync.test.ts` | the ones for pulled settlements and for the balance checksum | ~200 |
| `apps/mobile/src/receiptHtml.test.ts`, `csv.test.ts` | the settlement and payroll-sheet ones | 36 |
| `packages/shared/golden/runner.ts` (522) + `golden.test.ts` (86) + `real-repository.test.ts` (264) | the entire TypeScript runner. The ten `cases/*.json` **stay**: they become the server's regression suite, which already runs them in `services/api/internal/apitest/golden_test.go` | 872 |
| **Total tests** | | **≈ 1,964** |

**Total deleted ≈ 3,927 lines. Written ≈ 220. Net ≈ −3,700.**

On the server **not one line** is deleted. The rejection branch at
`handlers_sync.go:402` stays: it goes from being the one that fires to the one
that never fires, which is exactly where a guard belongs.

### 1.3 What stays — and here I argue with you

**The displayed balance: yes, and the code is already built for it.**
`SERVER_BALANCES_SCHEMA` (`schema.ts:839`) and `recordServerBalances` exist.
What changes is their status: today the server balance is a **checksum**
compared against the local one and thrown away (`engine.ts:634-693`); it becomes
*the* number. Three conditions that are not negotiable, because they are
literally the entire family of web console findings (A5, A6, A7):

1. it is never shown without the mark of when it arrived, **on the same line**,
   not in a header;
2. a phone that has never heard a balance does not show «$0» — it shows «no lo
   sé» (*I don't know*). The four-state union with no numeric member for the
   unknown, which the web's harvest module already got right;
3. with unsent advances, it shows the server balance minus what has not been
   sent, labelled «provisional» (*provisional*).

A side gain that is worth it on its own: today the phone's balance **lies** for
anyone who also did day work (§2.2), and `engine.ts:664-673` says so in writing
— a worker with weighings *and* day work is reported as a calculation bug, and
"two totals are not enough to tell *the phone knows less* from *the two
implementations disagree*". With a single balance, that ambiguity does not
exist.

**The `anticipo` receipt: yes, and it is easier than it looks.** An advance
receipt needs no calculation at all: name, *cédula*, date, amount handed over,
signature. `receiptHtml` already prints it; what comes off it is the breakdown
of weighings and the `paidCents` against a settlement (`ReceiptData.lines`,
`balanceCents`, `paidCents`). What is left is a ~90-line document instead of
180.

One caveat about that, and it matters: **the `anticipo` receipt cannot carry the
balance.** It would carry a six-day-old balance printed on a piece of paper the
worker keeps. It carries what was handed over, which is the only thing the phone
knows for certain.

**Where I disagree with you: if the phone shows the balance, it has to show the
movements too.** A picker who sees "$340,000" and cannot see where it comes from
cannot dispute it, and a balance that cannot be disputed is worse than none.
That means continuing to pull the `ledger` down and apply it —
`applyLedgerEntry`, `syncStore.ts:481-511`, 31 lines — even though settlements
are no longer pulled. It is the difference between deleting 82 lines and
deleting 113, and those 31 are worth it.

**Stays whole, untouched:** capturing weighings, correcting and soft-deleting
them, the five review rules, performance/IRL, the week, plot and worker reports,
the CSV, the outbox and its triggers, the sync engine for `worker` /
`workRecord` / `ledgerEntry`, both transports, season export and import, and the
v5→v6→v7 migrations.

---

## 2. What gets lost

### 2.1 Out at the plot, with no signal

| Today | Afterwards |
|---|---|
| Weigh, correct, delete | same |
| See the balance (derived locally) | see the last known balance, with its date |
| Give an `anticipo`, print its receipt | same |
| Give a `deduccion` | moves to the web |
| **Settle the week** | already forbidden by decision 5 (`PayWorker.tsx:112`) |
| **Pay against a settlement** | moves to the web |
| **Print the final settlement** | moves to the web |
| **Run the crew payroll and sign the payroll sheet** | moves to the web — **and on the web it does not exist yet** |
| **Undo the payroll** | moves to the web |

The honest half has to be said: **decision 5 had already lost most of that
list.** With no signal, today, the settle button is off. What the proposal
genuinely removes, and which does work today *with* a signal, is settling and
paying **from the phone**, and the crew payroll.

And the crew payroll is the loss that costs construction money: the web pays
**one at a time** (`apps/web/src/features/workers/PayWorkerPage.tsx`, 636 lines,
one worker per screen). It prints the payroll sheet (`SettlementsPage.tsx:118`),
but it has no "settle and pay all thirty" action. That has to be built, and it
is not optional: it is what the farm does on Saturdays.

### 2.2 A local defence that disappears

`pickups.isSettled` today prevents correcting or deleting a weighing that is
already inside a live settlement, **at the moment of writing**. With no local
settlements, that check is the server's and arrives late: the weigher corrects a
weight on Thursday out at the plot and the conflict (`WORK_RECORD_SETTLED`)
shows up when there is a signal, maybe on Saturday.

A cheap mitigation I recommend including from day one: keep pulling down the
claimed `payable_id`s as a **tombstone list** — a set of UUIDs, no amounts, no
prices, no names. It is not money, and it puts the warning back at the moment of
writing.

### 2.3 The day the server is down and somebody has to be paid

The realistic scenario, not the catastrophic one: **Saturday afternoon, thirty
pickers waiting, the farm has a signal but the server does not answer** — the
VPS down, the certificate expired, the database in maintenance, or the refresh
token burnt by API finding 1, which is closed now but which showed that this
happens.

- **Today:** the payroll is run from the phone, everyone is paid, the sheet is
  signed.
- **With the proposal:** no settlement is issued. There is a way out and it is
  decision 5: the cash is handed over as an `anticipo`, with its receipt, and
  the settlement is issued on Monday amortising it to the cent — golden case 02
  fixes that.

In other words: **the money does go out just the same**. What changes is the
piece of paper the picker takes home. It says «anticipo, $180.000» (*advance,
$180,000*), not «liquidación, semana del 24 al 30, 190,5 kg a $950, $180.000»
(*settlement, week of the 24th to the 30th, 190.5 kg at $950, $180,000*). For a
day labourer who does not know how much he weighed, that is worse. And whoever
leaves the farm that Saturday leaves without their account closed.

**The worst realistic scenario, named without decoration: the farm with no
stable connectivity.** Today Báscula is a product that works on its own, on one
phone, for a whole quarter, with no server. With the proposal, a phone with no
server is a notebook full of kilos. If today's farm is the only customer and has
a signal at the house in the evening, this costs nothing. If Báscula is going to
be sold to farms that may or may not have a signal, the proposal cuts off that
market — and that is a business decision, not an architectural one. If the
answer is "yes, I do want to sell to those farms", then neither this proposal
nor the current model is the answer: the answer is the "provisional" variant in
`sincronizacion.md` §6.4, and it has to be costed now rather than discovered
with the first farm that asks for it.

---

## 3. The 26 audit findings

### Evaporate by construction — 4

| # | Finding | Why it disappears |
|---|---|---|
| API 4 | Floating-point rounding makes phone and server disagree on **31 %** of settlements | With a single calculator there are no two numbers to compare. It is closed today; it stops **being able** to reopen. Exact arithmetic is still needed on the server, but the class "two implementations of the same money" ends |
| API 7 | The weigher's pull carries the price per kilo and every weekly price | A phone that does not calculate amounts **has no reason to receive a price**. Today it is closed with a role filter; with the proposal the price leaves the weigher's payload by design, not because of an `if` somebody can touch |
| API 9 (**open**, "needs design, not a patch") | What a role skipped never comes back: a phone that changes hands is left with an incomplete ledger | The phone **has no ledger**. The ledger is on the server and is read whole every time. **The proposal is the design the auditor said was missing** |
| — (`engine.ts:664-673`) | A worker with weighings *and* day work is reported as a calculation bug, and the comment itself says it cannot be decided from there | There is one balance. There is nothing to compare |

### Soften but remain — 3

| # | Finding | What changes |
|---|---|---|
| API 5 | The weigher writes workers through sync and enumerates ID numbers | Nothing: registering people in the field is kept |
| API 13 | Quantities with more decimals than fit, rounded silently | Nothing: the quantity is precisely what the phone does send |
| API 14 (open) | Suspending a farm does not cut live sessions (up to 15 min) | It remains, but the blast radius shrinks: in those 15 minutes a suspended phone can no longer settle or pay, only note kilos |

### Untouched — 19

API 1, 2, 3 (and the debt its fix opened: there is no route that frees the
already-existing voided settlements holding a live line), 6, 8, 10, 11, 12; and
the twelve console ones, A1 to A12.

With one caveat that has to be said out loud: **the twelve console findings
weigh more after the simplification**, because the console becomes the only
place money moves. A1 — a double click pays twice, $20,000 handed over where
$10,000 was approved — is closed. The day a failure of that family comes back,
there is no longer a phone to serve as a second opinion.

### Born from the simplification — 4

**N1. A number shown that cannot be verified.** This is exactly A5/A6/A7 moved
onto the phone. It is covered by the three conditions in §1.3, and they have to
be written before the first line, not audited afterwards.

**N2. The `anticipo` is handed over against a stale balance.** A foreman who
sees «$340.000 · hace 6 días» (*$340,000 · 6 days ago*) and hands over $300,000
may be handing over against a balance that has already been collected. It is not
a system failure — golden case 07 fixes that the excess behaves as an `anticipo`
and the balance goes negative — but it is money leaving somebody's pocket
against an out-of-date figure. The age has to sit right next to the amount.

**N3. The "this weighing has already been paid" warning arrives late.** §2.2. It
is born from removing `isSettled`, and the tombstone list gives it back.

**N4. The phone stops being a second copy of the farm's money.** Today, if the
server loses data, the phone's `.db` has all of it. After phase P7 it does not:
the phone has kilos and advances, and the rest lives only in Postgres. The
server backup stops being good practice and becomes the only thing there is.
**Somebody has to be named as doing it, and how often, before the cutover, not
after.**

**Scoreboard: 4 evaporate, 3 soften, 19 remain, 4 are born.**

---

## 4. The migration, with the real farm mid-harvest

The proposal **does not change the migration: it simplifies it.** The import is
already built (`services/api/internal/store/import.go`, 754 lines), keeps the
phone's UUIDs, is idempotent (`ON CONFLICT (id) DO NOTHING`) and **aborts the
whole transaction if a single cent of a single balance does not reconcile**
(`reconcileImport`, import.go:554-633). None of that is touched. What changes is
which app is left on top at the end.

| Step | What | Risk |
|---|---|---|
| **P0** | Turn settling off on the phone, without deploying code: wire up `capabilities.settleOffline` (today decoded and discarded) and put the §6.1 guard on `PaymentsPanel` too, which does not have it | **Low, and it is work, not risk.** Two conditionals. But until they exist, any plan has a crew payroll with no lock |
| **P1** | The backup, and **restored** onto a spare phone, with three figures compared against the original: the season's kilos, live settlements, and the balance of the worker with the most movements | **None.** It is a read. And without it everything else loses its safety net: a backup nobody has restored is not a backup |
| **P2** | The import rehearsal against a test database, as many times as it takes to come out clean | **None.** The database is disposable and the phone never knows: `SyncRepo.seasonExport` is a pure read, and the interface says so by returning a value and taking no callback |
| **P3** | **The cutover.** Tuesday morning, not a pay day, with somebody present. Money read-only mode → second backup → import against production with the three reconciliations **inside** the transaction → if anything fails, `ROLLBACK` | **THE ONLY STEP WITH RISK.** See below |
| **P4** | Pull only, 24 hours. The phone receives and does not send. Five balances, the week's kilos and the number of live settlements are compared by hand | **None.** Nothing has been written to the server from the phone; a mistake here is free |
| **P5** | Push. The outbox drains in order. Reconcile again | **None** *if and only if* P0 is done. If not, every pending local settlement in the outbox is rejected and raises a conflict card |
| **P6** | Deploy the version without calculation. **Here, and only here, the 1,963 lines are deleted** | **None.** By then the server has the season, reconciled to the cent, twice |
| **P7** | Read-only mode is lifted, the web's warning is removed, payment happens on the web. Decision 3's mitigation ends | **None technical.** See the warning in §6 |
| **P8** | The pre-migration backup is kept for the whole season. And now with more reason: N4 | — |

**Why P3 is the only one with risk, and what the real risk is.** It is not
losing data: until P6 nothing modifies the phone's SQLite destructively, and if
the server transaction aborts, the farm carries on exactly as it was, because
**the phone has not been touched**. The risk is **operational**: uploading
11.7 MB over a farm's link with a 25-second timeout (sprint 5 debt 4). A failure
there loses nothing — it is a response nobody read, and the retry is safe
because of the `ON CONFLICT` — but it leaves the farm in money read-only mode
longer than planned, on a Tuesday, with people waiting. **Raising that timeout
is the only server change the move requires, and it has to happen before that
Tuesday.**

**Why the others carry no risk, said once:** P1 and P2 are reads. P4 writes
nothing to the server. P5 only pushes facts — weighings and movements — which
are idempotent by UUID across three independent layers (§4). P6 deletes code
over data that is already reconciled. The safety comes from **the order**, not
from the care of whoever runs it.

**An order NOT to follow, because it is the tempting one:** deploy the
simplified app first and migrate afterwards. That leaves the farm unable to
settle on the phone and with the server not holding the season — that is, unable
to pay from either side.

---

## 5. The alternative plan, if the owner says no

What is left half-done today for the current model to be defensible, in order of
severity.

**A. Move `settle` to the server. Two weeks, one pair.**
This is the hole in §0. It means: calling `POST /v1/settlements` with
`expectedGrossCents` (the server already **requires** it,
`handlers_money.go:233`); taking `settlements` and `settlement_items` out of
`SYNCED_TABLES` so they stop being queued; building the `GROSS_CHANGED` screen
with both figures and the week that changed (§5.5); and rewriting `runPayroll`
as N server calls with its own partial-failure handling. Two weeks is the
**optimistic** estimate: `runPayroll` is the part with the most live edge cases
— `repository.test.ts` has eight tests dedicated to undoing a payroll alone,
including one for a `devengo` that was already reversed.

**B. Stop the phone's balance lying. Three weeks, one pair.**
`engine.ts:664-673` says it cannot be fixed from there. Actually fixing it means
pulling day work and contracts down to the phone, i.e. the mobile work-records
screen — point 4 of §10, which nobody has costed. It is a new screen, not a
tweak. Until it exists, the worker's page shows half a balance to anyone doing
both, and the red discrepancy card fires by design.

**C. The two P0 guards. One day.**
Wire up `capabilities.settleOffline` and put the §6.1 guard on `PaymentsPanel`.
They are needed whatever the owner chooses.

**D. Schedule the `sync_log`/`sync_ops` pruning. Half an hour.**
`main.go --prune` exists; the cron is missing.

**E. Raise the import timeout. One line.**

**Total for the alternative plan: about five pair-weeks**, against ~1,500 lines
written — versus ~3,900 deleted and ~220 written by the other route.

### Permanent risks accepted by whoever stays with the current model

Even with all of the above closed:

1. **Two implementations of the same money, for ever.** The ten golden cases
   exist because there are two engines. Every new rule — a capped `deduccion`,
   an `anticipo` that expires, per-batch rounding — has to be written twice, in
   TypeScript and in Go, and proved to agree. Finding API 4 — 31 % of
   settlements disagreeing — is what happens when one of the two is written from
   memory, and it will happen again, because the discipline that prevents it is
   not structural: it is somebody remembering.
2. **Two locks over the same fact.** `ux_items_pickup_live` in SQLite and
   `ux_items_payable_live` in Postgres. §1.4 says that is not a problem "once
   only one of the two can create a settlement" — that is, it is correct exactly
   to the extent that **A** is implemented, and not a day sooner.
3. **The conflicts screen has to be maintained and people have to be taught to
   use it.** It is the part of the system exercised only when something goes
   wrong, i.e. the part never tested in the field. With the current model there
   are six kinds of card and three of them are about money; with the proposal
   they come down to two — rejected weighing and deleted worker — and no money
   conflict reaches the weigher because there are none.

---

## 6. On sunk cost, without hedging

Almost everything that would be deleted was written this week: the whole
repository has two days of history. That is **not** an argument for keeping
anything, and it is worth saying why in a way that does not sound like a slogan:
the cost is already paid, and having paid it buys nothing going forward. The
useful question is what each line costs to maintain **from today**, and a line
that calculates money costs a golden case, a Go port, and a possible
discrepancy every time somebody touches it.

**There is one place where age *is* an argument, and it points in exactly the
opposite direction to the expected one.** What gets deleted is not the new code:
it is the old.

- Written yesterday and **never used by the farm**: the sync engine,
  `syncStore`, both transports, season export and import, the three sync
  screens, the v6 and v7 migrations. **They stay almost entirely.**
- Running on the farm for a season, paying real people: `payments.settle`,
  `runPayroll`, `PayWorker`, `PaymentsPanel`, `Account`, `BALANCE_SQL`,
  `PENDING_SQL`, the receipt. **That is what the proposal deletes.**

That is the real cost and it appears in no line count: the payroll has been done
for months with two buttons the weigher and the administrator know by heart, and
the proposal swaps them for a web screen that in its crew form does not exist
yet. Swapping code with mileage for code without mileage is the expensive part,
and it is not measured in lines — it is measured in a pay Saturday that does not
go well.

And a warning against my own recommendation: **this simplification is easier to
defend in a document than at five o'clock on a Saturday afternoon with thirty
people waiting.** If the owner accepts it, P7 is not lifted until the web pays a
whole crew in one screen, with its signed sheet, and somebody has done it once
with the paper in front of them.

---

## 7. Recommendation

**I recommend accepting the proposal, and the reason is coherence, not lines of
code: decision 5 already took the phone's authority over money away, and what is
left in `payments.settle` is a payroll engine the server rejects by design
(`handlers_sync.go:402`) while the payment that accompanies it does go through —
a double payment waiting for decision 3's mitigation to be lifted.** Keeping the
current model is not "not changing": it is committing to two weeks to move
`settle` to the server, three more to pull day work down to the phone so the
balance stops lying, and to sustaining two implementations of the same money for
ever. The proposal reaches the same place by deleting ~3,900 lines instead of
writing ~1,500, and makes four findings disappear by construction, including
number 9 — the only open one the auditor said "needs design, not a patch".

What it costs is real and has to be signed for with eyes open: the crew payroll
moves to the web and **has to be built there**, because today the web pays one
at a time; the picker collecting on a Saturday with the server down takes home
an `anticipo` receipt instead of a settlement; and Báscula stops working as a
standalone product on a phone. If that last property is part of the business —
selling to farms without reliable signal — then the answer is neither this
proposal nor the current model, but the "provisional" variant in §6.4, and that
has to be decided now.
