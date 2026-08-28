# Sync, tenants and roles

Design notes, written before any of it is built. Nothing here is implemented
yet; the mobile app still works entirely on its own device.

## The shape of the problem

A picker weighs in at a plot with no signal. The phone stores it. Hours or days
later there is signal, and what that phone knows has to reach the server without
losing anything and without inventing anything.

The hard part is not moving rows. It is that **the balance is derived from a
ledger of events**, and two devices that were both offline can post events about
the same week. If the merge is careless, somebody gets paid twice or not at all.

## Why events sync cleanly and totals do not

The mobile app already stores money as an append-only ledger: nothing is edited
or deleted, and a mistake is cancelled by its opposite. That decision, taken for
auditability, is what makes sync tractable — appending is commutative, so two
devices that each appended can be merged by taking the union.

What cannot be merged is a **derived total**. So the rule is:

> Devices exchange events. Balances are never sent, only recomputed.

A row is identified by a UUID generated on the device, not by an autoincrement
id, so the same pickup keeps its identity wherever it is stored. Re-sending a
row that already arrived is a no-op — sync has to be safe to retry, because the
connection will drop halfway.

## What actually conflicts

Pickups and payments append and merge without drama. Two operations genuinely
conflict:

**Two devices settle the same week for the same worker.** Today a unique index
over the live settlement lines stops a pickup being paid twice on one device.
Across devices the server has to be the one holding that lock: a settlement
carries the set of pickup ids it claims, and the server rejects a settlement
claiming a pickup that another settlement already holds. The rejected device
receives the winning settlement and re-derives; nothing is silently dropped.

**Someone edits a pickup that another device already settled.** The app already
refuses this locally and asks for the settlement to be voided first. The server
enforces the same rule, which means an edit made offline can be rejected on
arrival. The device keeps it as a pending correction and shows it — an
unresolvable conflict has to end in front of a person, never in a silent
overwrite.

**Ordering.** Wall clocks on cheap phones drift and are set by hand. Events
carry the device clock for display, but ordering for merge purposes uses a
per-device counter plus arrival order at the server. What a picker sees as
"today" comes from the local day the phone recorded, which is already how weeks
are keyed.

## Multi-tenancy

One database, one `farm_id` on every table, enforced in Postgres with row
level security rather than by remembering to add a `WHERE` — because the day
somebody forgets, one farm sees another's payroll.

A super-admin section, outside any tenant, creates farms and their first owner.
It is the only place that can cross tenants, and it should be able to create and
suspend farms, not read their ledgers.

## Roles

| Role | Can |
|---|---|
| **Super-admin** | Create and suspend farms. No access to a farm's data. |
| **Owner** | Everything in their farm, including prices, deleting and the account of every worker. |
| **Administrator** | Day-to-day running: register, settle, pay, correct. Cannot change prices or remove people. |
| **Weigher** | Register pickups, and see what they registered. No money, no balances, no other people's figures. |

The weigher role is why this matters on the phone: it is handed to whoever holds
the scale, often someone hired for the season, and it should not open the
payroll. Roles have to be enforced on the server too — a phone can be handed
around, and hiding a button is not a permission.

## Order of work

1. `packages/shared`: the ledger contract, so the three sides cannot drift.
2. API with tenants, roles and auth, and the mobile app reading its own data
   from it — no sync yet, just a server that exists.
3. Sync: push, pull, conflict rules, retry.
4. Web: farm administration, then super-admin.

Sync last on purpose. It is the part that can lose money, and it should be built
against a server whose rules are already settled.
