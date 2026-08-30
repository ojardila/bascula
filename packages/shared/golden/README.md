# Golden cases

JSON fixtures with inputs and **the exact numbers that must come out**. They
exist for one single reason: so the Go server does not calculate money
differently from the phone.

They are not mobile tests. They are the calculation contract, written in a
format both suites walk. If the phone and the server pass the same files, a
picker is paid the same no matter where the weighing was taken.

- `cases/*.json` — the cases, in file order.
- `runner.ts` — the TypeScript runner.
- `golden.test.ts` — the `node:test` suite that executes them.

The runner **reimplements nothing**: it imports `BASE_SCHEMA`,
`PAYMENTS_SCHEMA`, `PENDING_SQL`, `BALANCE_SQL`, `WEEK_OF` and `DAY_OF` from
`apps/mobile/src/schema.ts` and runs them under `node:sqlite`, exactly like the
suites that already existed. The only thing retyped is the *sequence of writes*
of a settlement, because `apps/mobile/src/db.ts` opens `expo-sqlite` at module
level and cannot be imported outside a phone (`docs/diagramas/movil.md` §9.2).
That sequence follows `Payments.settle`, `pay`, `advance`, `deduct`, `adjust`,
`reverse` and `voidSettlement` statement by statement.

---

## How to read a case

```jsonc
{
  "id": "saldo-a-favor",        // unique; the filename prefixes it with an order number
  "title": "…",                 // one line, for the suite's report
  "why": "…",                   // WHY it exists: what diverges if it is rewritten from memory
  "timezone": "America/Bogota", // the farm's timezone (see "Time" below)
  "generalRateCents": 80000,    // price per unit, in whole cents
  "weeklyRateCents": {          // optional: per-week overrides (Monday -> cents)
    "2026-08-24": 95000
  },
  "people": [{ "id": 1, "name": "Ana", "lastName": "Rodríguez" }],
  "crops":  [{ "id": 1, "name": "Lote 1" }],
  "events": [ /* … applied IN ORDER … */ ],
  "expect": { /* … what the database must contain at the end … */ }
}
```

### Rules of the format, no ambiguity

1. **Money is always a whole number of cents.** Every field ending in `Cents` is
   a signed integer that fits in `int64`. There is never a decimal in an amount.
   The suite checks this over the whole corpus, so a fixture with `4200000.5`
   fails before anything is compared.
2. **Business dates are plain `YYYY-MM-DD`**, no time and no timezone. They are
   days on the farm's calendar, not instants.
3. **The only exception is `pickup.at`**: a local wall-clock time,
   `YYYY-MM-DDTHH:MM` with no offset, because the offset is the farm's and not
   the file's. See "Time".
4. **`quantity` is the only thing that may carry decimals**: it is a measurement
   (kilos on a scale, baskets, a number of `jornal` days), with **three decimals
   at most** — the `numeric(12,3)` the server stores it in. What the file states
   is the **decimal**, not the nearest double: `1.005` does not exist in binary,
   and multiplying it as a float gives a different result from the server's
   (case 10). Read it as text — `json.Number` in Go, the literal itself in
   JavaScript — and multiply its digits, not its double.
5. **The keys that appear in `expect` are checked; the ones that are missing are
   not.** A case asserts what it says and nothing more.
6. **The ids are deterministic.** `people[].id`, `crops[].id` and `pickup.id`
   are given. Those of `settlements` and `ledger` are assigned by `AUTOINCREMENT`
   in write order starting at 1 — which is why a `void` or `reverse` event can
   point at them by number.

### Events

| `op` | Fields | What it does |
|---|---|---|
| `pickup` | `id`, `personId`, `cropId`, `quantity`, `at` | Records a weighing. `at` is local wall-clock time. |
| `settle` | `personId`, `from`, `to`, `on`, `note?` | Freezes into one settlement every unclaimed weighing whose **local day** falls between `from` and `to`, and posts the `devengo`. |
| `pay` | `personId`, `amountCents`, `on`, `method?` | Cash handed over. The amount arrives **positive**. |
| `advance` | `personId`, `amountCents`, `on`, `note?` | An `anticipo`. Positive. |
| `deduct` | `personId`, `amountCents`, `on`, `note` | A deduction (meals, a tool…). Positive. |
| `adjust` | `personId`, `signedCents`, `on`, `note` | A correction; **this one does arrive signed**. |
| `void` | `settlementId`, `on`, `note?` | Voids the settlement and releases its weighings. |
| `reverse` | `ledgerId`, `on`, `note` | Cancels a ledger movement with its opposite. |
| `checkpoint` | `label` | Writes nothing. Photographs the balances at that point in the story. |

`on` is "the day the farm believes it is" when the operation happens. It is in
the file and not taken from the clock, because a case has to give the same
result today and in three years. On the server, `on` is *today* in the farm's
timezone.

### What is compared

| `expect` key | Contents |
|---|---|
| `pickups` | `{ id, localDay, week }` per weighing, ordered by id. The local day and the Monday of its week. |
| `settlements` | `{ id, personId, periodStart, periodEnd, grossCents, status, items[] }`, ordered by id. Each `item`: `{ pickupId, week, quantity, costPerUnitCents, amountCents, voided }`, in the order they were written (which is the order of the weighing dates). |
| `ledger` | The whole ledger ordered by id: `{ id, personId, kind, amountCents, date, settlementId, reversesId }`. |
| `balances` | Per worker: `{ personId, earnedCents, paidCents, deductedCents, balanceCents, lastMovementAt }`. |
| `checkpoints` | `{ label, balances[] }` for each `checkpoint`, in order. |

---

## The rules these cases pin down

**Money.** `amountCents = round(quantity × rateCents)`, rounding **half away
from zero**. It is **not** banker's rounding: `2.5 × 8333 = 20832.5` gives
`20833`, not `20832`. And it rounds **per line**, adding whole numbers
afterwards — rounding the sum gives a different total.

And the multiplication is **exact**, not floating point. `math.Round(quantity *
float64(rateCents))` in Go, or `Math.round(quantity * rateCents)` in
JavaScript, do **not** satisfy this rule: the nearest double to `1.005` sits
below it, the exact product `7537.5` lands on `7537.499999999999` and the
rounding goes down to `7537` instead of up to `7538`. Always one minor unit
short, always against the worker. The only way to give the same answer as
`numeric` in Postgres is to multiply the quantity's **decimal digits** by the
whole rate: `big.Rat` in Go (`domain.AmountMinor`), `BigInt` in TypeScript
(`amountCents`). That is case 10, and with 18,616 pairs checked against
Postgres — including the entire family whose product falls exactly on the half,
in both signs — the three implementations agree on every one.

**Signs.** Positive = the farm owes the worker. `devengo` > 0; `pago`,
`anticipo` and `deduccion` < 0; `ajuste` and `reverso` free, never zero. The
methods receive positive magnitudes and the data layer puts the sign on. A
`reverso` is classified in the breakdown **by its sign**, not by the kind of the
movement it cancels.

**Balance.** `balanceCents` is `SUM(amountCents)`, plain. It is never stored: it
is derived. `earnedCents` / `paidCents` / `deductedCents` are a breakdown for
the screen, and `ajuste` appears in none of the three even though it does appear
in the balance.

**Time.** The week is the **ISO date of its Monday** (`2026-08-24`), never a
`%Y-W%W` label. A weighing's business day is its day **in the farm's timezone**,
not in UTC: the instant is converted to the timezone and *then* the day is taken
out. Deriving the week straight from the UTC instant puts Sunday evenings into
the following week.

> For an engine in Go: `pickup.at` is interpreted in the case's `timezone` —
> `time.ParseInLocation("2006-01-02T15:04", at, loc)` — and stored as a UTC
> instant. In `America/Bogota` (UTC−5), `2026-08-30T19:30` is
> `2026-08-31T00:30Z`: **Monday in UTC, Sunday on the farm.** That is exactly
> case 04.
>
> The TypeScript runner builds the instant from the wall-clock parts with the
> process's timezone, so the suite gives the same result on any machine: what
> the file states is the wall-clock time, and SQLite's `'localtime'` undoes the
> conversion with the same offset.

**The lock.** A weighing belongs to at most **one** live settlement
(`UNIQUE(pickupId) WHERE voidedAt IS NULL`). Voiding does not delete: it marks
the lines with `voidedAt` — which is what releases the weighing — and posts a
`reverso` of the `devengo`. In the server's generalised model the column is
called `payable_id`, but the partial index is the same.

---

## The cases

| # | id | What it pins down |
|---|---|---|
| 01 | `saldo-a-favor` | Collecting less than what was earned leaves the rest as the worker's credit balance. |
| 02 | `anticipo-mayor-que-la-semana` | An `anticipo` bigger than the week is paid off against several weeks, with the balance checked week by week. |
| 03 | `semana-a-caballo-de-dos-anios` | The week of 29 December is **one** week, with **one** price, on both sides of the year. |
| 04 | `domingo-por-la-tarde-en-colombia` | A Sunday 19:30 weighing in Colombia — Monday in UTC — belongs to the week being paid, and to that week's rate. This bug already happened. |
| 05 | `liquidacion-anulada-y-reliquidada` | Voiding releases the weighing, leaves the worker owing what was collected, and the weighing is settled again exactly once. |
| 06 | `redondeo-medio-centavo` | Products that fall exactly on half a cent: half up, and rounding per line. |
| 07 | `pago-mayor-al-saldo` | A payment bigger than the balance leaves a negative balance and behaves like an `anticipo`. The balance is not clipped. |
| 08 | `deduccion-reverso-y-ajuste` | The sign table: `deduccion` on its own, `reverso` classified by sign, `ajuste` outside the breakdown. |
| 09 | `pesada-tardia-de-semana-ya-liquidada` | A weighing recorded late rolls over to the next settlement, at **its own** week's price. |
| 10 | `tres-decimales-que-el-float-pierde` | The exact product falls on the half but the double sits below it: the multiplication has to be exact, not float. With a flat-price control that does not diverge. |

## Adding a case

1. Create `cases/NN-whatever-it-is.json` with a new `id` and a `why` that says
   what breaks if somebody rewrites it from memory. The `why` comes out in the
   failure message: it is what whoever breaks it will read.
2. `npm test --workspace @bascula/shared`.
3. If the case paints a behaviour the mobile app does **not** have today, it is
   not a golden case: it is a change proposal. These files describe what the
   farm is already doing with real money.

Adding a case forces the server to pass it. That is deliberate: that is what
they are for.
