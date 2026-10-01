# Teams («Equipos») — use cases

> Some pickers work and get paid as one unit: a couple, two brothers, a family.
> They fill one sack, the scale shows one number and one person collects the
> money. Before teams existed, farms recorded them as one fake "person" named
> «Yorman y Sergio», which paid correctly but counted two people as one in
> every statistic (Finca San José, week of 2026-09-28: 15 people/day and
> 193 kg/person/day instead of 17 and 170, and a picker wrongly flagged by the
> 70 % rule).
>
> Owner's decision (2026-09-30): "Two employees and a concept *equipo*; the
> account balance is per team." Conventions follow
> [`employees.md`](employees.md): concepts in English, exact Spanish UI labels
> «like this».

## 1. Model

- A worker (`employees`) has `kind`: `persona` (default) or `equipo`.
- `team_members(team_id, employee_id, from_day, to_day)` keeps the history of
  who was in which team. `to_day` is inclusive and null while it lasts.
- Database rules (trigger `team_members_check`, migration `00040_teams.sql`):
  a team is an `equipo`, a member is a `persona` (no teams inside teams), and a
  person is in at most one team on any day.
- **The team is the payee.** Weighings, settlements («liquidaciones»), the
  balance, advances, deductions, payments, receipts and per-person price
  exceptions all belong to the team's `employee_id`.
- **Members are real people.** While a person is in a team they have no
  personal weighings, advances or deductions: the API answers
  `409 WORKER_IN_TEAM` (details: `teamId`, `teamName`). A balance they had
  before joining stays payable to them.
- **If only one member comes, still weigh to the team.** The day counts N
  people (N = members that day). The owner chose this to keep it simple.

## 2. Statistics count people, not accounts

| Figure | Rule |
|---|---|
| People picking (today / this week / per lote) | distinct members (a person outside a team counts as themself) |
| Person-days | a team day counts N |
| kg/person/day, the farm average | kilos ÷ person-days |
| 70 % flag («por debajo del promedio») | the team's kilos per member per day vs the farm average |
| Ranking («Modo cosecha») | one row per team: «392 kg c/u · 785 kg juntos», sorted by kilos each |
| Member profile | «Su parte» = team kilos ÷ members, per day; the team is named |
| Comparative index and outlier rule (reports) | kilos per head |

`picker_ids(employee, day)` and `team_heads(employee, day)` (SQL functions)
are the single definition every report uses.

## 3. Use cases

### TEAM-01 Create a team
Actor: owner or admin. Workers → «Nuevo» → choose «Equipo», name it, give it
its own basket number («Número de canasto», required; the members keep
theirs — see [basket-numbers.md](basket-numbers.md)), tick the members («¿Quiénes son?») and the date they start
(default today). Each member must already exist as a person; the form can
create them on the spot. Route: `POST /v1/workers` with `kind: "equipo"`,
`memberIds`, `membersFrom`. MCP: `create_team`.

### TEAM-02 Convert a combined record into a team
A record named «Yorman y Sergio» is changed to `kind: "equipo"` (it keeps its
id, tag, weighings and money), the two people are created as persons, and they
are added as members from the first day they worked together. Route:
`PATCH /v1/workers/{id}` `{kind: "equipo"}` then `{memberIds, membersFrom}`.
Once a team has had members it cannot go back to `persona`.

### TEAM-03 Change members
Edit the team, tick or untick people, pick «desde» (from). Whoever leaves stops
being a member the day before; a membership that had not started yet is
removed. Route: `PATCH /v1/workers/{id}` `{memberIds, membersFrom}`. MCP:
`set_team_members`. Deactivating or archiving the team ends its memberships
today.

### TEAM-04 Weigh a team
The scale screen and «Registro masivo» show the team as one row
(«Equipo de 2 · Yorman, Sergio»), findable by any member's name or tag;
members are hidden while they are in a team. Offline works the same way: the
worker list (with `kind`, `memberIds` and `teamId` in the sync feed) is cached
on the phone. MCP: `register_weighing` and `register_harvest_week` with the
team's id.

### TEAM-05 Settle and pay a team
Same as a person: «Liquidar» and «Pagar» on the team's account
(«Cuenta del equipo»). The payment can say «¿Quién recibe la plata?»
(`receivedBy`, a member that day); it appears on the receipt. How the members
split the cash is their business. MCP: `create_settlement`, `register_payment`
(`receivedBy`).

### TEAM-06 See a member
The member's profile shows «Está en el equipo …» with a link to the team's
account, and «Su parte»: their share of the team's kilos per week. There is no
personal balance to pay while they are in the team.

### TEAM-07 Read the harvest
«Modo cosecha», weekly reports and the ranking count people as in section 2.
MCP: `report_harvest_dashboard`, `report_weeks`, `report_performance`,
`worker_performance`.

### TEAM-08 Assistants (ChatGPT / Claude)
`list_workers` returns `kind`, `members` and `team`. `create_worker` warns when
a name looks like two people ("X y Y") and suggests `create_team`. See
[`docs/mcp/README.md`](../mcp/README.md#teams-equipos).

## 4. Out of scope

- Splitting a team's money between its members.
- Weighing members separately inside a team.
- A person in two teams on the same day.
