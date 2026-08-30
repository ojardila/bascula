# `bascula-web` — the farm administration console

Vite + React + TypeScript + React Router + MUI. Spanish in the interface, code
comments in English, **money always in whole cents**.

Since sprint 2 this app talks to the real API (`services/api`). The mock data is
still there, but as a tool, not as the only reality.

## Getting it up

```sh
npm install --prefix apps/web --no-workspaces   # install here, not at the root
npm --prefix apps/web run dev                   # http://localhost:5173
```

By default it starts on **mock data** and says so on screen: a blue banner at
the top warns that nothing you record reaches the server. Log in with
`oscar@laesperanza.co` / `esperanza` (owner); the login screen also lists the
administrator, the weigher and the super-admin.

| Command | What it does |
|---|---|
| `npm run dev` | development server |
| `npm run build` | checks the generated types, `tsc -b` and bundles into `dist/` |
| `npm run types:api` | regenerates `src/api/schema.ts` from `services/api/openapi.yaml` |
| `npm run types:check` | fails if those types are out of date (`build` runs it) |
| `npm test` | Vitest against MSW: hermetic, no network |
| `npm run test:e2e` | Vitest against the live API (see below) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint |

## Mocks or the real thing

One variable decides, and there is **no automatic fallback**: a mode that can
change on its own is a mode nobody can reason about at four in the afternoon.

```sh
VITE_USE_MOCKS=true      # MSW answers inside the browser
VITE_USE_MOCKS=false     # requests go out to VITE_API_URL
VITE_API_URL=http://localhost:8099
VITE_API_BASE_URL=       # leave it empty: the routes are relative and go through the proxy
```

The choice is visible in three places: the variable, a line in the console at
startup, and the banner on screen when it is mocked.

### Against the real API

```sh
cd services/api
make up
make migrate
PORT=8099 SIGNUPS_PER_IP_PER_HOUR=100 \
  DATABASE_URL="postgres://bascula_api:bascula_api_dev@localhost:5433/bascula?sslmode=disable" \
  go run ./cmd/api
```

and in `apps/web/.env.development` set `VITE_USE_MOCKS=false`.

In development the server **does not send email**: it returns the verification
token inside the signup response, so the «Revise su correo» (*check your email*)
screen offers a link to confirm and log in without a mailbox.

**The Vite proxy is not a convenience.** The API mounts no CORS middleware, so a
page served on `:5173` cannot call `:8099` directly: the preflight comes back
without headers and the browser throws the response away before our code ever
sees it, which looks like a network fault and sends you hunting in the wrong
half of the system. `vite.config.ts` forwards `/v1` and `/health` to
`VITE_API_URL`, which makes it the same origin and leaves no preflight to fail.
In production the same property has to hold per deployment: serve the bundle
behind the same origin as the API, or put a reverse proxy in front of both.

## The end-to-end test

`npm run test:e2e` runs the app's real client (`src/api/endpoints.ts`, the same
code the browser executes) against a real server with a real database, and walks
the path that matters: register a farm, confirm, log in, hire, open a plot, set
a price, record two work records, **settle**, pay part of it and check the
balance.

It is the only test in the repository that can detect that the two halves do not
fit together. `npm test` runs against MSW, so it only confirms that the web
agrees with the web's idea of the API; the Go suite runs against Postgres, so it
only confirms that the API agrees with itself. Both were green all through
sprint 1 while `POST /v1/signup` from this app was a 400.

If the server is not up, **it skips with a notice saying which command to run**,
and it does not pass. An integration test that reports success without ever
having connected is worse than not having one.

## How it is laid out

```
src/
  api/
    wire.ts       what the server actually sends (transcribed from the Go structs)
    adapters.ts   the wire -> view translation, in one place and with the whys
    types.ts      the view models: what a screen is allowed to know
    endpoints.ts  one function per call; screens never use `http`
    refs.ts       the name tables for the client-side joins
    client.ts     fetch, transparent refresh, errors as `ApiError`
    errors.ts     translation of `code` -> a sentence in Spanish
    mode.ts       mocked or real, explicit and visible
    schema.ts     GENERATED from openapi.yaml; never edited
    contract.assert.ts  checks wire.ts against schema.ts at compile time
  auth/           session and the role matrix (a table, not ifs)
  components/     AppShell, ModuleList (the module mould), Money, guards
  features/       one folder per module (plots, workers, activities,
                  workrecords, inventory, sales, expenses, config, admin)
  lib/            money, dates, uuidv7, map geometry (geo.ts), stock.ts
  mocks/          MSW, emulating the real API route by route
e2e/              the test against the live server
```

Five things worth knowing before touching anything:

1. **There are two vocabularies and one translation.** The server says `docId`,
   `unidad_trabajo`, `admin`; the interface says `documentNumber`, `work_unit`,
   `administrator`. `adapters.ts` is the only place they cross. That is what let
   the API grow eight routes and change three shapes halfway through the sprint
   without touching a single screen.
2. **The server sends ids, not names.** A work record (*Labor*) brings
   `workerId`, `activityId`, `unitId` and `plotIds`, and not one readable
   string. The join is done by the client (`refs.ts`), against the data it had
   to load anyway for its own pickers. An id that does not resolve is shown as
   «—», never blank: an empty cell in the Lotes (*plots*) column reads as «sin
   lote» (*no plot*), which is a different and convenient fact.
3. **Paying is two writes.** Settling (`POST /v1/settlements`) is what turns
   work into money owed; only then is there a balance to pay against. Skipping
   the first step gives a 409 `AMOUNT_EXCEEDS_BALANCE` that makes no sense until
   you know this.
4. **`components/ModuleList.tsx` is the mould.** Every list screen uses it. With
   ten modules ahead, a new module that does not use it is a module that
   diverges.
5. **`lib/money.ts` is the only money arithmetic.** A deliberate port of
   `apps/mobile/src/format.ts`; it will move to `packages/shared` when that
   package exists, and that is the only place that will have to be touched.

### The contract, and who rules over the types

`services/api/openapi.yaml` now exists, so the debt declared in sprint 2 —
"`wire.ts` is transcribed by hand" — was closed, but **not** by replacing
`wire.ts` with the generated code. The three files live together and each has a
job:

```
src/api/schema.ts           generated, never edited by hand (npm run types:api)
src/api/wire.ts             hand-written, commented, what the app imports
src/api/contract.assert.ts  no runtime: checks that the two say the same thing
```

The generated file is 6,500 lines of
`components["schemas"]["Sale"]["properties"]`. Reading a screen's data flow
through that is worse than reading it in `wire.ts`, and every comment about "why
this arrives null" — the ones that cost an afternoon each — has nowhere to live
in a generated file. So the generated one is the **judge**, not the source:

- `contract.assert.ts` compares, at compile time, the set of fields and the
  types of each `Wire*` against its schema. If the server renames a field, `tsc`
  fails **saying which one**: `["sobra en wire.ts:", "warehouse"]` (*surplus in
  wire.ts*).
- `scripts/check-openapi-types.mjs` runs on every `npm run build` and fails if
  `schema.ts` has fallen behind `openapi.yaml`. Regenerating is a deliberate act
  with a reviewable diff, and **that diff is the notice that the contract
  moved**. Regenerating silently inside the build is exactly how sprint 1 spent
  a week with the two halves in disagreement and green on both.

It has already found things: `WireActivityRate.timeUnit` was typed as `string`
when the contract has an enumeration of five values (and the server says
`personalizado` where the interface says `custom`).

## What the API does not have yet

These things are in the interface and the adapter returns an honest emptiness
instead of inventing a plausible value, which is how a screen ends up being
trusted for a figure nobody computes:

- **Employee photo.** `photoId` points at a media store that does not exist;
  there is no URL to build, so the avatar falls back to the initial.
- **Start date.** There is no column. `createdAt` is when the row was created,
  which is not when the person joined.
- **Receipt number.** The API issues none; the payment screen prints the id of
  the ledger movement, which is at least something you can quote.
- **Owner's email and employee count in the platform console.** The super-admin
  cannot read a farm's users or employees: the projection *is* the restriction.
- **The farm's trial period.** It does not exist in the API. The mock invented
  it.

## The map

The plot's polygon is drawn, edited and saved against
`PUT /v1/plots/{id}/boundary` (GeoJSON both ways). It lives in
`features/plots/PlotBoundaryEditor.tsx` and in `lib/geo.ts`.

**There are no tiles, and that is not a degraded version.** This console is
published under a policy that rejects requests to servers other than its own
origin — the same rule that lets it be served next to the API without CORS. Any
tiled map (OSM, Mapbox, Esri, Google) is a `fetch` per 256-pixel square against
somebody else's domain, so Leaflet or MapLibre here would not be "a map with
slow tiles": they would be a grey rectangle with gestures, 140 kB of tile cache,
and an owner who concludes, rightly, that the screen is broken. It was checked
before a line was written: no tile source is same-origin, the repository does
not ship an offline tile pack, and the API does not serve `/tiles`.

What there is instead is a **coordinate canvas**: a local equirectangular
projection in metres, centred on the plot, with a metric grid, a scale bar, the
real latitude and longitude of each corner, and **the farm's other plots drawn
behind it in grey**. That last one is what does the job an aerial photo would
do: from the second plot onwards, the boundary that matters is the neighbour's.
And, optionally: a **background image supplied by the owner** (a drone shot, a
cadastral plan, a screenshot taken somewhere else), anchored to the frame it was
dropped on, which stays in that browser and is not uploaded anywhere; and the
**device's own location** through `navigator.geolocation`, which is a browser
permission and not an external server.

The two areas — the declared one and the polygon's — are always shown together
and at the same size (`AreaComparison`), with the difference stated in hectares
and as a percentage, in a neutral tone and without scolding: the declared one
comes from the deed and the polygon from tracing a hillside with the mouse, and
which of the two is useful is the owner's call. An `INVALID_GEOMETRY` is said in
Spanish and **on top of the drawing**: `lib/geo.ts` detects the crossing before
the network and paints the two sides that overlap in red.

The area shown while drawing uses the spherical-excess sum over the **authalic
sphere** (authalic latitude included), which is what `ST_Area` over `geography`
does internally: for the example square in `openapi.yaml`, PostGIS answers
122.506 ha and this code computes 122.5055. The naive version of the same
calculation gives 123.04, and half a hectare jumping when you press Save is
exactly what makes nobody trust either figure.

## Inventory, sales and expenses

RSP-018 … RSP-033, on top of the same `ModuleList`. Two design rules are baked
into the types, not into a comment inside a form:

- **Stock is derived from the movements.** There is no field on any screen that
  accepts typing a stock quantity, and there is no `updateStock` in
  `endpoints.ts`. The only way for a number to move is `createStockMove`, which
  adds a fact. The dialog shows the result before saving — «hoy hay 28, después
  quedan 38» (*there are 28 today, 38 left afterwards*) — so the number you were
  going to type stays in sight, but you reach it by saying what happened. The
  sign is set by the reason (`stock_sign`), not by the person.
- **An expense is charged to an activity or to a plot/crop, never to both and
  never to neither.** `ExpenseInput` is a discriminated union, so "both" and
  "neither" are not shapes the form can build; and on screen, the fields of the
  type that was not chosen are not disabled, they **do not exist**.

## What is still missing

Settlements as their own screen, users, RSP-009 and the sale receipt attachment
(`/v1/uploads` exists on the server; the screen does not upload files yet, and
would rather not put up a box that swallows the photo). The sidebar shows the
missing modules greyed out with the sprint they arrive in.

**The sync warning is still up and still true**: until sync exists, a work
record entered here does not exist for the phone and vice versa, and the
double-payment lock lives in each database separately. Pay from one side only.
