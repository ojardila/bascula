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
| 9 | What a role skipped never comes back: a phone that changes hands is left with an incomplete ledger | Open — needs design, not a patch |
| 12 | Public signup is an oracle for accounts and passwords | Open — the honest fix means moving the creation of a second farm behind a session |
| 14 | Suspending a farm does not cut live sessions (up to 15 minutes) | Open |
| 11 | Reports: a week with no harvest disappears and the curve reads as joined across the gap; a truncated window is presented as a full week | Open |

Debt that the fix for #3 opened itself: the import no longer **creates** voided
settlements holding a live line, but **there is no route that frees the ones
that already exist**.

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
