# Adversarial audits

Two auditors from outside the team attacked the system with a brief to break it:
one the API, the other the web console. They did not read code looking for
theories — they ran attacks and left behind the scripts that reproduce them.

This document is the scoreboard. A finding counts as closed only when **the
script that found it fails**, not when somebody says it is fixed.

## What held, which is the part that reassures most

Worth reading before the list of failures, because it is the part of the system
you can trust.

**Isolation between farms.** 67 combinations of route and verb, crossing
identifiers from one farm against another: not a single access got through. And
— this matters as much as that does — **zero routes where "not yours" reads
differently from "does not exist"**: same codes, same messages. All 32 tables
carrying `farm_id` have row level security enabled, forced, and with a policy;
none of the new migrations was left out.

**The double-payment lock.** 16 simultaneous settlements of the same worker and
period, ten times over: always exactly one accepted. Settling against voiding in
parallel: the books balance in all ten.

**Idempotency of money.** The same identifier with a different amount, a
different worker or a different kind: rejected. Eight simultaneous retries of
the same payment: one movement.

**Roles, in the API and in the console.** The weigher gets 403 at every door to
money and personal data. Eight lines of attack from the browser — direct URL,
history, saved session, forging the role inside the token — none gave way. On
denied routes not one request fires, so no data reaches the browser to be hidden
afterwards.

**SQL injection.** None.

## API — 14 findings

Thirteen closed. The one that is open is open by decision, not by neglect.

| # | What | State |
|---|---|---|
| 1 | A replayed refresh token blocks the request; ten of them switch the API off for every farm | **Closed** |
| 2 | The overpayment guard does not exist under concurrency; same for stock and sales | **Closed** |
| 3 | The import does not reconcile: invented credit, one person's weighings paid to another, weighings trapped with no way out, dates from 1900 | **Closed** |
| 4 | The tenth golden case: floating-point rounding makes phone and server disagree on 31 % of settlements | **Closed** |
| 5 | The weigher writes workers through sync, and enumerates ID numbers | **Closed** |
| 6 | Deleting a worker hides their debt from the balances list | **Closed** |
| 7 | The weigher's pull carries the price per kilo and every weekly price | **Closed** |
| 8 | The cap on farms per email address is never enforced | **Closed** |
| 10 | Push breaks its own contract: a reused identifier returns somebody else's id and the phone loses the weighing | **Closed** |
| 13 | Quantities with more decimals than fit are rounded silently | **Closed** |
| 12 | Public signup is an oracle for accounts and passwords | **Closed** |
| 14 | Suspending a farm does not cut live sessions (up to 15 minutes) | **Closed** — all three of the family |
| 11 | Reports: a week with no harvest disappears and the curve reads as joined across the gap; a truncated window is presented as a full week | **Closed** |
| 9 | What a role skipped never comes back: a phone that changes hands is left with an incomplete ledger | Open — needs design, not a patch |

Debt that the fix for #3 opened itself: the import no longer **creates** voided
settlements holding a live line, but **there is no route that frees the ones
that already exist**. Closed in sprint 8 with `POST /v1/settlements/{id}/release`.

### The last three, and what closing them cost

**12 — the signup oracle** was two oracles. The password half was closed in
sprint 8 by moving "add a farm to an account that exists" behind a session
(`POST /v1/farms`). What was left was the 409 itself, which told any stranger
whether an address is registered — a phishing list, and the first step of the
attack the 409 was the second step of. It now answers the same 201, with the
same body, for every address; the branch that creates nothing runs the whole
creation against a synthetic address and discards it, because 2 ms beside 26 ms
says the same thing to anyone who does not read bodies. Measured before: 26.2 ms
against 2.0 ms. After: within noise of each other.

The response therefore names nothing. `farmId` and `userId` moved to
`POST /v1/auth/verify-email`, which is the first request whose caller has proved
the address is theirs. **This is a contract change the web console has to
follow**: `apps/web/e2e/live-api.test.ts` asserts them on the signup response,
and `apps/web/src/api/endpoints.ts` maps them there.

And the person who typed somebody else's address by mistake is told to check
their mail, and no mail comes. That is a worse minute for them than "ese correo
ya tiene cuenta" would have been, and it is the right trade, because the
alternative tells every stranger the same thing it tells them. What they should
get is a message to the address saying somebody tried to register with it —
which needs the mail sender this service still does not have.

**14 — the third case of the family.** FARM_SUSPENDED cuts a session when the
platform stops trusting the farm; MEMBERSHIP_REVOKED when the farm stops
trusting the person. The case in between was the one that cost money: an
administrator demoted to weigher kept `role: admin` in a signed claim for the
rest of its fifteen minutes, and that claim is what the permission table reads
AND what `app.role` puts in front of row level security. It is checked now in
the same round trip as the other two — 401 ROLE_CHANGED, because unlike its
siblings the remedy works: a refresh re-reads the membership, both clients
already retry once after refreshing, and the person sees nothing. What the
demoted person meets afterwards is an ordinary 403, in the role they hold.

**11 — the truncated window and the peak over a hole.** The empty week was
already in the series. Two things were not: every route that returns week totals
now carries `coveredFrom`, `coveredTo` and `partialWindow` — the week detail,
the list (including the truncation by `limit`, which nothing said) and the
curve (including the truncation by `weeks`, which is where it matters most,
because the peak of a cut window can be the cut itself). And the peak now stops
at the same hole the falling run stops at: it is the maximum of the unbroken
stretch the reading is made of, with `contiguousWeeks` saying how wide that
stretch is. One response naming a peak on the far side of a gap that
`fallingWeeks`, in the same response, refused to cross was two numbers
disagreeing about what the series is.

> The Go reading and its TypeScript twin in `packages/shared/src/harvest.ts` have
> diverged: the phone has neither the gap-safe run nor this. That file is not
> ours to change; it is written down here so the next person who reads "the port
> is line for line" knows it is not.

### The debt we opened ourselves, measured

The season import holds its pool connection, `idle in transaction`, for the
whole upload — the transaction is opened by the tenant middleware before the
handler has a byte of the body, and the body may take 25 minutes. Called
acceptable for a once-in-a-farm's-life act, and it is, until several owners move
in the same week. Measured on a laptop, the upload compressed to make the shape
visible:

| Imports at once | Connections held | Ordinary traffic |
|---|---|---|
| 2 | 2 of 10 | 180 requests, 0 failures, median 2.9 ms |
| 11 | **10 of 10** | 180 requests, 0 failures, median 4.6 ms, **max 17.8 s** |

Nothing errors, which is the dangerous part: pgx queues, so the pool going dry
looks like the whole service getting slower, on every route, for every farm,
with `/health` answering throughout. At the real deadline that 17.8 s is
25 minutes.

Fixed with two numbers that only work together: at most three imports at a time,
and a pool three connections larger than the ordinary ten, so the imports borrow
their own and never the ones a payroll screen is waiting on. Re-measured with
eleven at once: **3 held, ordinary traffic median 3.4 ms, max 9.5 ms**, and the
other eight refused.

The refusal took a second attempt. Written the obvious way — answer 429 and
return — the fourth client never saw the 429 at all: it was still sending twelve
megabytes, and what came back was `Errno 32, Broken pipe`. An owner told "no se
pudo subir" learns nothing and retries at once. The refusal now hands its pool
connection back first (`tenant.ReleaseEarly`), drains the upload, and then
answers, so the 429 and its `Retry-After` actually arrive. Verified both ways:
at full speed and trickled over 18 s.

### The final sweep of the zero trap

"A sum over an id that matches nothing comes back as a plausible *this produced
nothing*." Four doors were still open, and all four were in neither of the two
tables that walk this rule (`sprint2_test.go`, `sprint3_test.go`), which is
exactly why:

* `GET /v1/work-records` and `GET /v1/pickups` — `workerId`, `activityId`,
  `plotId`, `plotCropId`, unguarded on both the console's door and the phone's.
  Every row carries `amountCents`.
* `GET /v1/activities/{id}/rates` — pay rates, and an empty rate list is a real
  state: it is what makes a record fall back to the weekly price.
* `GET /v1/products?categoryId=` — a believable "no products in that category".

All four confirm the id first now. `GET /v1/sync/bootstrap` was checked and does
not exist: cursor 0 on `GET /v1/sync/pull` is the bootstrap, and it refuses a
cursor ahead of the feed rather than answering "you are up to date".

## Web console — 12 findings

| # | What | State |
|---|---|---|
| A1 | **A double click pays twice.** Verified: $20,000 handed over where $10,000 was approved | **Closed** |
| A2 | The value leaks to the weigher through the one route with no guard, and with it the price per kilo the server hides from him | **Closed** |
| A3 | The signed payroll sheet prints the result of a search: a $2,220,080 payroll comes out as $335,280 | **Closed** |
| A4 | The settlement header figures are sums over the filter, without saying so | **Closed** |
| A5 | The employee profile says «$0» when the request failed | **Closed** |
| A6 | The dashboard: two honest tiles and two that lie, off the same failed request | **Closed** |
| A7 | Estimates summed and presented as firm; `amountIsEstimate` is not painted anywhere | **Closed** |
| A8 | «Nunca ha entrado» (*never signed in*), shown to the owner who was using the application at the time | **Closed** |
| A9 | The invitation promises an email nobody sends and throws the password away: the invitee can never sign in | **Closed** |
| A10 | «Líneas: 0» (*lines: 0*) on every settlement: the server sends the count and the web counts an empty array | **Closed** |
| A11 | The «Periodo» (*period*) column always shows one week; the paper prints it right and the screen does not | **Closed** |
| A12 | Minor ones: a footer saying «0 ventas» (*0 sales*) underneath an error alert, an invented status in English | **Closed** except the form that is lost on reload, which is a missing feature and not a lie |

Four of the auditor's seven suspicions turned out to be true and are closed: an
unknown area that turned into «0,00 ha» and was added to the farm's total; a
total that added sacks to kilos and labelled the result with the first unit it
came across; a failed stock read painted as an empty warehouse, which
**pushed people towards disabling the server's guard**; and a request fan-out
that turned a failure into «todavía no se ha liquidado nada en esta finca»
(*nothing has been settled at this farm yet*).

## What these two audits teach

Almost every console finding is **the same family**: a figure shown when in fact
the value is not known. The team solved it well — very well — in the harvest
module, with a four-state union that has no numeric member for the unknown case.
And never went back to the older screens.

The lesson is not "watch out for zeros". It is that **a pattern solved in one
place does not spread on its own**, and that the only way to find out where it
is missing is to have an outsider go looking.

### And a lesson about the tests themselves

The double payment did not show up in the suite, for two reasons worth
remembering:

`fireEvent` and `userEvent` wrap in `act()`, and in doing so they hand React the
re-render that a real double click **does not**. The test was kinder than the
world.

And the server mock **was not idempotent by identifier**, even though its own
header promised it was. It was more permissive than production, so the failure
could not be reproduced against it. A mock that departs from the server in the
direction of letting more through is not a safety net: it is a blindfold.

## What outside contributors found that we did not

Seven security PRs arrived from someone with no stake in our assumptions, and
they landed on the two places our own audits were structurally unable to reach.

### A counter that records refusals feeds itself

It appeared twice, in two unrelated PRs, and neither author saw it as the same
bug. The signup limiter writes its attempt row before the cap is consulted, so
a request already refused with 429 still counts toward the next refusal. Five
unauthenticated requests an hour, from any address, keep a chosen email
permanently unable to register. The login limiter proposed in another PR had
the identical shape: ten wrong guesses at a known owner's address, then the
owner's **correct** password, and the door says 429. Forty requests an hour
hold a farm's owner out of their own payroll.

The rule that generalises: **a rate limiter whose counter is fed by its own
refusals is a denial-of-service primitive aimed at the account it protects.**
Count what actually reached the check, or count only genuine failures, and
prefer a delay over a hard block on any axis an attacker chooses freely.

### The audit read the function; the request took another path

We had convinced ourselves that `clientIP` did not trust `X-Forwarded-For`.
Reading the function, that is true — it parses `r.RemoteAddr` and nothing else.
Reading the request, it is false: `server.go` runs `middleware.RealIP`, which
has already overwritten `RemoteAddr` from the header before `clientIP` is ever
called. chi ships that middleware marked `Deprecated:` for exactly this reason.

**A function's guarantee is only worth what the chain in front of it leaves
intact.** Nothing in the code we read was wrong. We read the wrong span.

### An unused migration number is not free

Master ran to `00021` with no `00020` on file. Two independent branches then
picked `00020`, because it looked available. `store/migrate.go` calls
`goose.UpContext` without `WithAllowMissing`, so a database already carrying
history refuses to migrate at all:

```
goose up: error: found 1 missing migrations before current version 21:
         version 20: 00020_week_prices_are_money.sql
```

The suite cannot catch it. Every run migrates a fresh scratch database, where
ordering is never violated — so the first database to say no is production's.
Git shows no conflict either: the two branches touch different filenames.

`scripts/check-migrations.sh` now runs in CI and refuses anything at or below
master's high-water mark, gaps included. It is the class of fault where the
cost of the check is three seconds and the cost of the miss is every deployed
site refusing to boot.

### The door with no counter was the one everybody knocks on

`POST /v1/signup` got a Postgres-backed limiter in migration 00002, on the
grounds that it was "the most exposed surface in the system". It is not.
Signup costs an attacker a mailbox they control and gives them a farm they
could have had anyway. `POST /v1/auth/login` is where somebody else's payroll
is, and it counted nothing at all: no lockout, no delay, and no row anywhere
afterwards saying it had been tried. Measured on master, single-threaded: **200
wrong passwords at one address from one IP, 200 × 401, in 4.5 s.** A spray
could run all night and leave the database looking exactly as it did the night
before.

The same handler answered by the clock. An address with no account returned
before the Argon2id verification and one with an account returned after it:
**p50 19.20 ms against 0.65 ms, 29.5×, with zero overlap across 120 samples.**
The bodies were identical — the comment in the code said so, and it was true
about the bytes and false about the reply. A single request classified an
address, which is the same disclosure `handleSignup` builds `DiscardChanges`
to avoid giving, on the stated grounds that "a list of addresses that are
coffee farm owners in Huila is a phishing list".

Two rules came out of it, and the second is the one that keeps being relearned:

- **A limiter belongs on the door that is knocked on, not on the door that was
  designed first.** Which surface is "most exposed" is a claim about traffic
  and value, and it was written down once, in 00002, and never revisited.
- **Two branches that return the same bytes are not the same answer.** Equal
  cost is a property of the whole path, so the decoy hash is only worth
  anything because everything before it happens for both addresses — and
  `user == nil` is deliberately the LAST condition in the check that follows,
  because moving it first would short-circuit the work back out of existence
  and put the millisecond gap straight back.

The counter it shipped with also had to be shaped around the class above:
counting refusals per address alone would have made the fix a way to hold a
farm's owner out of their own payroll. It counts the (address, source IP) pair
instead, which is NIST SP 800-63B §5.2.2's own recommendation for this shape,
and concedes what that concedes: a search spread thinly across many sources is
slowed by the per-IP axis rather than stopped. The pair keeps the budget an
attacker spends their own.
