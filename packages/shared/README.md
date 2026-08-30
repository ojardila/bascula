# @bascula/shared

What **must not diverge** between the phone, the Go API and the web.

The criterion is the one in `docs/arquitectura-api.md` §7 and it is deliberately
narrow: only what, if written twice and written differently, **costs money**
gets in here. Everything else stays where it is used.

```
src/enums.ts    LedgerKind · PayMethod · Role · SettlementStatus · PayMode · ActivityCategory
src/money.ts    toCents · fromCents · amountCents(qty, rate) · the sign table by kind
src/time.ts     mondayOf · parseDay · addDays · weekNumber · localDayOf · weekOf
src/format.ts   formatMoney · formatNumber · formatWeekRange · formatDay
src/harvest.ts  readHarvest — reading the shape of the harvest curve
golden/         the golden cases. See golden/README.md
```

## Why each thing is here

**The enums** are closed sets that travel over the wire. `deduccion` written
with an accent on one side is a deduction that stops being counted.
`src/enums.test.ts` compares them against the real `CHECK`s in
`apps/mobile/src/schema.ts`: adding a `kind` in one place and not the other
fails in the suite, not on a farm on a Sunday afternoon.

**Money** is a single multiplication — `round(quantity × rateCents)` — and a
table of six signs, and those two are exactly where two languages diverge in
silence: banker's rounding instead of half away from zero, rounding the total
instead of each line, or — the third one, which cost four cents per settlement —
doing the multiplication in floating point, where `1.005 × 7500` never reaches
the half that has to be rounded up. `amountCents` multiplies the quantity's
decimal digits in `BigInt`, like `big.Rat` in Go and `numeric` in Postgres. See
`golden/README.md`.

**Time** decides which price applies. The week is the Monday's date, never
`%Y-W%W`; the business day is the day **in the farm's timezone**, not in UTC.
Both rules have already been broken once each.

**The formatters** come from the mobile app without a line changed. They are
here because a receipt printed from the server and one printed from the phone
have to read identically: the worker compares them. And because formatting by
hand — instead of `Intl` — is the reason `$1.471.070` does not come out as
`$1,471,070` on an Android with its locale set to `en-US`.

## What is NOT here, on purpose

- **`db.ts` and `schema.ts` stay on the phone.** They are SQLite and they belong
  to the phone; the server runs Postgres. What crosses over is not the SQL, it
  is its **behaviour**, and that is pinned by the golden cases.
- **`csv.ts`, `strings.ts`, `receiptHtml.ts`, `cropTypes.ts`.** They are pure
  and portable, but if they diverge it does not cost money: it costs a misplaced
  comma. When the web needs to export, `csv.ts` is the first candidate to move
  up.
- **DTOs and API clients.** `openapi.yaml` is the source of truth and they are
  generated (`oapi-codegen` for Go, `openapi-typescript` for web and mobile). A
  hand-written type here would compete with the generated one.

## How it is consumed

No build step and no dependencies: Node 26 executes TypeScript directly and the
tests are `node:test` + `node:sqlite`.

The mobile app imports by **relative path** (`../../../packages/shared/src/…`),
not by package name. That is on purpose: Metro already watches the monorepo root
— `serverRoot` is the root, not `apps/mobile` — so a relative path resolves
without `metro.config.js`, without a link in `node_modules` and without touching
the lockfile. The phone is in production in the middle of the harvest; this was
the option with the fewest moving parts. When the web and the API come in,
migrating to `@bascula/shared` is a `sed`.

```bash
npm test       --workspace @bascula/shared   # 48 tests
npm run typecheck --workspace @bascula/shared
```

`npm test` at the root runs the mobile app **and** this package (109 tests).
That sum lives today in the script in `apps/mobile/package.json`; the clean
thing is one line at the root — `"test": "npm test --workspaces --if-present"` —
but that is a change to the root `package.json` and is left decided elsewhere.

## A note for the backend

`ActivityCategory` has **three** values here (`siembra`, `mantenimiento`,
`cosecha`), following `docs/arquitectura-api.md`. `docs/modelo-datos.md`
declares a fourth, `otra`. The two documents disagree and nobody has decided:
it is flagged in `src/enums.ts` rather than resolved by eye. Also missing is
`StockReason`, which `arquitectura-api.md` §7 mentions but for which there is
nothing to calculate yet.
