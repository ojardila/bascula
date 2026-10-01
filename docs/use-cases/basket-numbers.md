# Basket numbers («Número de canasto») — use cases

Every picker carries a basket with a number painted on it. That number is how
the person at the scale finds somebody fast, so Báscula treats it as a
first-class field of every worker and team. In the data and the API it is the
existing `employees.tag` column (`tag` on the wire); the UI always calls it
«Número de canasto» (basket number).

## 1. Rules

| Rule | Where it is enforced |
| --- | --- |
| **Required when creating** a person or a team. Blank (only spaces) counts as missing. | Web forms («Escriba el número de canasto.»), `POST /v1/workers` (400, `details.fields.tag`), MCP `create_worker` / `create_team` (required in the input schema). |
| **Trimmed** before it is stored: « 46 » is saved as «46». | API (`store.NormalizeTag`). |
| **Unique among the farm's ACTIVE workers and teams**, ignoring case. An inactive worker's number can be given to somebody else. | API pre-check that names the holder (`409 DUPLICATE_TAG`, `details.employeeId`, `name`, `lastName`, `tag`), backed by the existing partial unique index `ux_employees_tag (farm_id, tag) WHERE deleted_at IS NULL AND tag IS NOT NULL` (migration 00003). |
| **Can be changed, not removed** once a worker has one. | `PATCH /v1/workers/{id}`: an explicit `null` or blank on a worker who has a number is a 400. |
| **Workers from before the rule may have none.** Nothing breaks: they show a small «Sin canasto» badge and an offer to add one. Saving other fields of such a worker does not require a number. | Web (badge, profile prompt), API (`null` on a worker without a number is a no-op). |
| **A team has its own number** (e.g. «46-63», or the number of the basket they share). **Members keep theirs.** A team's number cannot repeat a member's (they are both active workers). | Same uniqueness rule. |

No migration was needed: the column and the partial unique index already
existed. Before shipping, every farm was checked for active duplicates (none)
and workers without a number (they stay as «Sin canasto»).

## 2. Where the number is shown

- **Empleados (list):** a big yellow tile with the number in front of each name
  (green for a team); «Sin canasto» badge (tap → edit) when missing. The search
  box finds by name, basket number or ID.
- **Profile:** the tile (88 px) and a «Canasto 46» chip under the name; a
  warning «Esta persona no tiene número de canasto…» with «Poner número» when
  missing.
- **Scale («Pesar»):** the field is «Persona o número de canasto»; each option
  shows the tile; typing a number puts the exact match first («4» → the
  basket 4 before 45 and 46). Typing a member's number finds the member, and
  picking a member picks their team. The chosen person/team is confirmed below
  the field with a 64 px tile.
- **Registro masivo:** each row starts with the tile; «Buscar por nombre o
  canasto».
- **Modo cosecha ranking:** the tile next to each name; «Hoy sin registro»
  chips start with the number. `GET /v1/reports/harvest-dashboard` (and MCP
  `report_harvest_dashboard`) now return `tag` on `people[]` and `notToday[]`.
- **Nómina de cuadrilla:** the tile in both tables; «Buscar por nombre o
  canasto» (an exact number matches).
- **Team form / members card:** each person shows their own tile.

## 3. Use cases

### BASKET-01 Register a person with their basket number
Actor: owner or admin. Empleados → «Nuevo empleado». The first field, in big
type, is «Número de canasto». Saving without it shows «Escriba el número de
canasto.» under the box. If an active worker already has it, the box says
«Ese número ya lo tiene Yorman Pérez.» and nothing is saved.
Route: `POST /v1/workers` with `tag`. MCP: `create_worker` (`tag` required).

### BASKET-02 Register a team with its own number
Empleados → «Nuevo equipo». «Número de canasto» is required («El equipo tiene
su propio número, por ejemplo 46-63. Cada persona conserva el suyo.»). A new
person added from the team form («Agregar una persona nueva») also needs a
number. Route: `POST /v1/workers` `{kind: "equipo", tag, memberIds}`. MCP:
`create_team` (`tag` required).

### BASKET-03 Give a number to a worker who has none
The list shows «Sin canasto»; the profile shows the warning with «Poner
número». The edit form explains «Esta persona todavía no tiene número de
canasto. Escríbalo aquí.» — but does not force it, so their phone or name can
still be corrected. Route: `PATCH /v1/workers/{id}` `{tag}`. MCP:
`update_worker` with `tag`.

### BASKET-04 Change a number
Edit the worker and type the new number. A taken number is refused naming
the holder. Removing the number is refused (400).

### BASKET-05 Find somebody by their number
Type the number in the scale, Registro masivo, the payroll or the workers
list. MCP: `list_workers q=46`; `register_weighing` and
`register_harvest_week` tell the assistant to translate numbers this way and
confirm the name.

### BASKET-06 Reactivate somebody whose number was given away
`PATCH {status: "active"}` is refused with `DUPLICATE_TAG` naming who has the
number now; send `{status: "active", tag: "<new>"}` to come back under a new
number. When a weighing from a phone automatically reactivates them
(decision 8), they come back **without** a number («Sin canasto») instead of
failing the phone's sync, and the office gives them a new one.

### BASKET-07 Offline phone
The sync feed already carries `tag`, so the cached worker list on the phone
searches by number offline. A worker created from a phone (`/v1/sync/push`)
is checked for duplicates the same way (`DUPLICATE_TAG`), but not required to
have a number, so handsets from before the rule keep working.

## 4. Tests

- API and MCP: `services/api/internal/apitest/basket_number_test.go`.
- Web: `features/workers/basket.test.ts` (search and ranking),
  `WorkerFormPage.test.tsx` and `TeamFormPage.test.tsx` (required, duplicate
  names the holder), `HarvestPages.test.tsx` (ranking shows the number).
