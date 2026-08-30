/**
 * The move, rehearsed against the real server and real Postgres.
 *
 *     cd services/api && make up && make migrate && make dev     # port 8099
 *     node apps/mobile/src/sync/move.e2e.ts
 *
 * `seasonImport.test.ts` proves the same properties against a fake server that
 * behaves the way `store/import.go` is documented to behave. That is the right
 * place for them — it runs on a laptop with no Docker — but it has one blind
 * spot it cannot close by construction: **the fake agrees with our reading of
 * the contract.** If `DisallowUnknownFields` refuses a field we send, if a
 * `date` is a `time.Time` and not a `civil.Date`, if the 409's `details` is
 * shaped differently from the `mismatchesOf` parser, if a real 12 MB body does
 * not survive a real socket — every one of those passes against the fake and
 * loses the farm's Tuesday morning.
 *
 * So this file is deliberately outside the `*.test.ts` glob, like
 * `live.e2e.ts`, and deliberately does the whole thing for real: it signs up a
 * NEW farm through `POST /v1/signup`, fills a handset with a season, and moves
 * it with the same `SeasonImporter` the screen drives. It is still typechecked,
 * so it cannot rot silently.
 *
 * The four rehearsals, which are §8 fase 4's four fears:
 *
 *   1. **The whole move.** ~18,000 weighings, 22 weeks at different prices,
 *      anticipos, deducciones, voids and re-settlements. It reports
 *      what it really weighed, how long it really took, and it reads every
 *      worker's balance back OUT of the server through `GET /v1/workers/{id}`
 *      to check it against the handset to the centavo. The server checks the
 *      balances it was SENT; only reading them back proves what it STORED.
 *   2. **The link that drops halfway**, then the retry. The socket is
 *      cut while the body is still climbing, which is the case that decides
 *      whether a retry is free.
 *   3. **A balance that does not add up**, against real Postgres, and the farm
 *      has to come out with nothing on it — not half a payroll.
 *   4. **The second import** over a farm that already received one.
 *
 * Each rehearsal gets its OWN farm, because a rehearsal that shared one would
 * be reading the previous rehearsal's rows and calling them its own.
 */

import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "../data/nodeSqlite.ts";
import { createSqliteRepository } from "../data/sqliteRepository.ts";
import type { Repository } from "../data/repository.ts";
import { ApiError, HttpClient } from "./http.ts";
import { FarmSession, memorySecretStore } from "./session.ts";
import { RestTransport } from "./restTransport.ts";
import {
  SeasonImporter,
  seasonWasImported,
  toImportInput,
  byteLengthOf,
  rowsOf,
  SEASON_IMPORT_TIMEOUT_MS,
  type SeasonImportInput,
  type SeasonImportOutcome,
  type SeasonImportReport,
  type SeasonImportTransport,
} from "./seasonImport.ts";
import { verifySeasonExport } from "./seasonExport.ts";
import { amountCents } from "../../../../packages/shared/src/money.ts";

const BASE = process.env.BASCULA_API ?? "http://localhost:8099";
/** How many weighings the rehearsal season carries. The real one is ~18.000. */
const PICKUPS = Number(process.env.MUDANZA_PICKUPS ?? 18000);

const log = (...a: unknown[]) => console.log(...a);
const rule = (title: string) =>
  log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);

// ---- A farm that did not exist a second ago -----------------------------

interface Farm {
  farmId: string;
  email: string;
  password: string;
  session: FarmSession;
  http: HttpClient;
}

/**
 * Sign up, verify, log in. The whole of what an owner does before the mudanza.
 *
 * `verificationToken` comes back in the body because the dev server runs with
 * DevEcho on; on a real deployment it is mailed. Refusing to log in before it
 * is consumed is the server's decision and this walks it rather than reaching
 * into Postgres to flip a column, because reaching into Postgres would be
 * rehearsing a path the owner does not have.
 */
async function freshFarm(label: string): Promise<Farm> {
  const email = `mudanza-${label}-${Date.now()}@laesperanza.co`;
  const password = "mudanza2026segura";

  const anon = new HttpClient({
    baseUrl: BASE,
    session: {
      current: () => null,
      refresh: async () => {
        throw new ApiError("UNAUTHORIZED", "no session", 401);
      },
      clear: () => {},
    },
  });

  const created = await anon.request<{
    farmId: string;
    userId: string;
    verificationRequired: boolean;
    verificationToken?: string;
  }>("/v1/signup", {
    method: "POST",
    anonymous: true,
    body: {
      farm: {
        name: `Finca Ensayo ${label}`,
        timezone: "America/Bogota",
        currency: "COP",
        priceCents: 95000,
      },
      owner: { email, name: "Dueño de ensayo", password },
    },
  });

  if (created.verificationRequired) {
    if (!created.verificationToken)
      throw new Error(
        "the server asks for verification and returned no token: start the API with DevEcho",
      );
    await anon.request("/v1/auth/verify-email", {
      method: "POST",
      anonymous: true,
      body: { token: created.verificationToken },
    });
  }

  const session = new FarmSession({ baseUrl: BASE, store: memorySecretStore() });
  const http = new HttpClient({ baseUrl: BASE, session });
  return { farmId: created.farmId, email, password, session, http };
}

/** Register a handset against the farm and hand back a live importer. */
async function handset(
  farm: Farm,
  repo: Repository,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SeasonImporter> {
  const deviceId = repo.sync.identity().deviceId;
  const registered = await farm.session.login(farm.email, farm.password, deviceId);
  repo.sync.claimFarm(registered.farmId);
  const http = new HttpClient({
    baseUrl: BASE,
    session: farm.session,
    fetchImpl: opts.fetchImpl,
  });
  return new SeasonImporter({ repo, transport: new RestTransport({ http }) });
}

// ---- The season this phone has been holding since February ---------------

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);
const SEASON_START = Date.UTC(2026, 1, 2, 11, 0, 0); // a Monday
const DAY = 86400000;

const V5_SCHEMA = `
  CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, lastName TEXT, documentType TEXT, docId TEXT, tag TEXT,
    image TEXT, deletedAt TEXT, createdAt TEXT);
  CREATE TABLE crops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, type TEXT, variety TEXT, dimension REAL,
    deletedAt TEXT, createdAt TEXT);
  CREATE TABLE pickups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    personId INTEGER, cropId INTEGER, weight REAL NOT NULL, date TEXT, createdAt TEXT);
  CREATE TABLE config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cropType TEXT, label TEXT, unit TEXT, yieldUnit TEXT, costPerUnit REAL, language TEXT);
  CREATE TABLE cost_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT UNIQUE, costPerUnit REAL);
  CREATE TABLE settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, personId INTEGER NOT NULL,
    periodStart TEXT NOT NULL, periodEnd TEXT NOT NULL, grossCents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', note TEXT, createdAt TEXT NOT NULL, voidedAt TEXT);
  CREATE TABLE settlement_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, settlementId INTEGER NOT NULL,
    pickupId INTEGER NOT NULL, week TEXT NOT NULL, weight REAL NOT NULL,
    costPerUnitCents INTEGER NOT NULL, amountCents INTEGER NOT NULL, voidedAt TEXT);
  CREATE UNIQUE INDEX ux_items_pickup_live
    ON settlement_items(pickupId) WHERE voidedAt IS NULL;
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, personId INTEGER NOT NULL, kind TEXT NOT NULL,
    amountCents INTEGER NOT NULL, date TEXT NOT NULL, settlementId INTEGER,
    method TEXT, note TEXT, reversesId INTEGER, createdAt TEXT NOT NULL);
  CREATE INDEX ix_pickups_date ON pickups(date);
  CREATE INDEX ix_pickups_dup ON pickups(personId, cropId, weight, createdAt);
  INSERT INTO config (id, cropType, label, unit, yieldUnit, costPerUnit, language)
    VALUES (1, 'cafe', 'Café', 'kg', 'kg por recolector', 800, 'es');
  PRAGMA user_version = 5;
`;

interface Phone {
  db: DatabaseSync;
  repo: Repository;
  shape: {
    workers: number;
    plots: number;
    weeks: number;
    pickups: number;
    deletedPickups: number;
    settlements: number;
    voided: number;
    resettled: number;
    advances: number;
    deductions: number;
  };
}

/**
 * A season with the four things that make a nómina hard, not just a big one.
 *
 * A generator that only writes weighings and payments produces a payload that
 * reconciles trivially, and a rehearsal against it proves the happy path and
 * nothing else. What actually decides whether the arithmetic survives the move
 * is the corrections:
 *
 *   - **different prices per week**, so a re-settlement at a corrected
 *     price produces a different amount for the same kilos, which is the whole
 *     reason `week_prices` travels at all;
 *   - **anticipos and deducciones**, which are the two negative kinds that are
 *     not `pago` and which the ledger's CHECK constrains differently;
 *   - **voids**: a settlement voided, its lines voided with it (which
 *     releases their weighings under `ux_items_pickup_live`), and a `reverso`
 *     cancelling its `devengo` — three rows that have to stay consistent
 *     across the wire or the balance moves;
 *   - **reliquidaciones**: the same weighings settled again at the corrected
 *     price. This is the case that exercises the lock from both sides — a
 *     weighing claimed by a dead line and a live one at once — and it is the
 *     one a naive import breaks.
 *
 * Written under the v5 schema and then put through the real v6 and v7
 * migrations, so every uuid on the wire is one `migrateToV6` minted from the
 * row's own instant.
 */
function buildSeason(pickupCount: number): Phone {
  const db = new DatabaseSync(":memory:");
  db.exec(V5_SCHEMA);
  db.exec("BEGIN");

  const people = 24;
  const plots = 4;
  const weeks = 22;

  const person = db.prepare(
    "INSERT INTO people (name,lastName,documentType,docId,tag,createdAt) VALUES (?,?,'CC',?,?,?)",
  );
  for (let i = 1; i <= people; i++)
    person.run(
      `Recolector${i}`,
      `Apellido${i}`,
      String(1000000 + i),
      `C${i}`,
      iso(SEASON_START),
    );

  const plot = db.prepare(
    "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,'Café',?,?,?)",
  );
  const varieties = ["Castillo", "Caturra", "Colombia", "Tabi"];
  for (let i = 1; i <= plots; i++)
    plot.run(`Lote ${i}`, varieties[i - 1], 2 + i * 0.5, iso(SEASON_START));

  // A different price every week, which is what a farm actually does: the
  // price follows the market and the settlement follows the price.
  const priceOf = (w: number) => 80000 + w * 1500;
  const priceRow = db.prepare(
    "INSERT INTO cost_overrides (week, costPerUnit) VALUES (?, ?)",
  );
  for (let w = 0; w < weeks; w++)
    priceRow.run(day(SEASON_START + w * 7 * DAY), priceOf(w) / 100);

  // The weighings, spread over the season's working days.
  const pk = db.prepare(
    "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
  );
  const workDays = weeks * 6; // Sundays off
  const perDay = Math.ceil(pickupCount / workDays);
  interface Row {
    id: number;
    personId: number;
    week: number;
    weight: number;
    when: number;
  }
  const rows: Row[] = [];
  let made = 0;
  for (let w = 0; w < weeks && made < pickupCount; w++)
    for (let d = 0; d < 6 && made < pickupCount; d++)
      for (let k = 0; k < perDay && made < pickupCount; k++, made++) {
        const when = SEASON_START + (w * 7 + d) * DAY + k * 977;
        // Three decimals, because a scale reports them and a float that is
        // summed in a different order on the server has to still compare equal.
        const weight = Math.round((8 + (made % 47) * 0.973) * 1000) / 1000;
        const personId = (made % people) + 1;
        const id = Number(
          pk.run(personId, (made % plots) + 1, weight, iso(when), iso(when))
            .lastInsertRowid,
        );
        rows.push({ id, personId, week: w, weight, when });
      }

  // Settle each worker's week, at that week's price.
  const st = db.prepare(
    `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,note,createdAt,voidedAt)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const li = db.prepare(
    `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents,voidedAt)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const le = db.prepare(
    `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );

  const byWeekPerson = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.week}:${r.personId}`;
    const bucket = byWeekPerson.get(key);
    if (bucket) bucket.push(r);
    else byWeekPerson.set(key, [r]);
  }

  let settlements = 0;
  let voided = 0;
  let resettled = 0;
  let advances = 0;
  let deductions = 0;

  // The last week is left unsettled on purpose: a farm mid-harvest always has
  // one, and a season where everything is closed hides the case where a
  // weighing belongs to no settlement at all.
  for (let w = 0; w < weeks - 1; w++) {
    const paidAt = SEASON_START + (w * 7 + 6) * DAY;
    const paidDay = day(paidAt);
    const monday = day(SEASON_START + w * 7 * DAY);

    for (let p = 1; p <= people; p++) {
      const mine = byWeekPerson.get(`${w}:${p}`);
      if (!mine || !mine.length) continue;

      // Every seventh worker-week is settled wrong, annulled, and settled
      // again at the right price. That is the reliquidación.
      const wrong = (w * people + p) % 7 === 3;
      const usedPrice = wrong ? priceOf(w) - 700 : priceOf(w);

      // `CHECK (amount_minor = round(quantity * price_minor)::bigint)` is on
      // the server's `settlement_items` — a real constraint, not a convention.
      //
      // And `Math.round(weight * price)` does NOT satisfy it, which this
      // rehearsal found the hard way: the first run was refused at one line
      // out of 686. Postgres multiplies `numeric(12,3)` exactly; a double
      // does not. `Math.round(1.005 * 7500)` is 7537 because the nearest
      // double to 1.005 sits below it and the exact 7537.5 lands at
      // 7537.499999999999. The farm's scale reports three decimals all day.
      //
      // `amountCents` from `@bascula/shared` is the multiplication both ends
      // agree on: the quantity's decimal digits in BigInt, rounded half away
      // from zero. It exists for exactly this, and a fixture that reimplemented
      // it in floats would be rehearsing a season the farm cannot have.
      const amountOf = (r: Row, price: number) => amountCents(r.weight, price);
      const gross = mine.reduce((n, r) => n + amountOf(r, usedPrice), 0);
      if (gross <= 0) continue;

      const sid = Number(
        st.run(
          p,
          monday,
          paidDay,
          gross,
          wrong ? "void" : "open",
          null,
          iso(paidAt),
          wrong ? iso(paidAt + DAY) : null,
        ).lastInsertRowid,
      );
      settlements++;
      for (const r of mine)
        li.run(
          sid,
          r.id,
          monday,
          r.weight,
          usedPrice,
          amountOf(r, usedPrice),
          wrong ? iso(paidAt + DAY) : null,
        );

      const devengoId = Number(
        le.run(p, "devengo", gross, paidDay, sid, null, null, null, iso(paidAt))
          .lastInsertRowid,
      );

      if (wrong) {
        // ANULACIÓN. The settlement dies, its lines die with it — which
        // releases every weighing under `ux_items_pickup_live` — and the
        // devengo is cancelled by a reverso rather than deleted.
        voided++;
        le.run(
          p,
          "reverso",
          -gross,
          day(paidAt + DAY),
          sid,
          null,
          "voids the settlement priced wrong",
          devengoId,
          iso(paidAt + DAY),
        );

        // RE-SETTLEMENT. The same weighings, at the price that was right.
        const rightGross = mine.reduce((n, r) => n + amountOf(r, priceOf(w)), 0);
        const rsid = Number(
          st.run(
            p,
            monday,
            paidDay,
            rightGross,
            "open",
            "reliquidación",
            iso(paidAt + DAY + 3600000),
            null,
          ).lastInsertRowid,
        );
        settlements++;
        resettled++;
        for (const r of mine)
          li.run(rsid, r.id, monday, r.weight, priceOf(w), amountOf(r, priceOf(w)), null);
        le.run(
          p,
          "devengo",
          rightGross,
          day(paidAt + DAY),
          rsid,
          null,
          "reliquidación",
          null,
          iso(paidAt + DAY + 3600000),
        );
        // And it is paid, so the corrected week closes.
        le.run(
          p,
          "pago",
          -rightGross,
          day(paidAt + DAY),
          null,
          "efectivo",
          null,
          null,
          iso(paidAt + DAY + 7200000),
        );
        continue;
      }

      // Most weeks are paid. Not all: a farm always owes somebody something,
      // and a reconciliation over a set of zeroes proves nothing.
      if ((p + w) % 5 !== 0)
        le.run(p, "pago", -gross, paidDay, null, "efectivo", null, null, iso(paidAt + 60000));

      // ANTICIPO, mid-week, in cash out at the lote.
      if ((p + w) % 4 === 1) {
        advances++;
        le.run(
          p,
          "anticipo",
          -(20000 + ((p * 7 + w) % 9) * 5000),
          day(SEASON_START + (w * 7 + 2) * DAY),
          null,
          "efectivo",
          "anticipo en el lote",
          null,
          iso(SEASON_START + (w * 7 + 2) * DAY),
        );
      }

      // DEDUCCIÓN: the shop, the boots, the advance on the tools.
      if ((p * 3 + w) % 11 === 2) {
        deductions++;
        le.run(
          p,
          "deduccion",
          -(3000 + ((p + w) % 5) * 1200),
          paidDay,
          null,
          null,
          "tienda",
          null,
          iso(paidAt + 120000),
        );
      }
    }
  }

  db.exec("COMMIT");

  const repo = createSqliteRepository(nodeSqlite(db), { timezone: "America/Bogota" });
  repo.init(); // the real v6 and v7 migrations, over the rows above

  // VOIDED WEIGHING. A handful of weighings the weigher cancelled, which
  // travel WITH their tombstone: leaving them out would make the server's
  // count disagree with the phone's for a reason nobody could reconstruct.
  // Only ones no live settlement line claims, which is what the phone's own
  // `isSettled` guard enforces at the moment of writing.
  const orphans = db
    .prepare(
      `SELECT p.id FROM pickups p
        WHERE NOT EXISTS (SELECT 1 FROM settlement_items i
                           WHERE i.pickupId = p.id AND i.voidedAt IS NULL)
        ORDER BY p.id DESC LIMIT 40`,
    )
    .all() as { id: number }[];
  const kill = db.prepare("UPDATE pickups SET deletedAt = ? WHERE id = ?");
  for (const o of orphans) kill.run(iso(SEASON_START + weeks * 7 * DAY), o.id);

  return {
    db,
    repo,
    shape: {
      workers: people,
      plots,
      weeks,
      pickups: rows.length,
      deletedPickups: orphans.length,
      settlements,
      voided,
      resettled,
      advances,
      deductions,
    },
  };
}

// ---- Reading the farm back OUT of the server -----------------------------

/**
 * Every worker's balance, as the SERVER reports it after the import.
 *
 * This is the half `POST /v1/import/season` structurally cannot do for us. It
 * compares its own derivation against the balances it was SENT, inside the
 * transaction, before committing — which proves the payload was coherent. It
 * says nothing about what came out the other side of the commit. Only asking
 * the server afterwards, through the route the web console reads, closes that.
 */
async function serverBalances(farm: Farm): Promise<Map<string, number>> {
  const body = await farm.http.request<{
    items?: { workerId: string; balanceCents: number }[];
  } | { workerId: string; balanceCents: number }[]>("/v1/balances");
  const items = Array.isArray(body) ? body : (body.items ?? []);
  return new Map(items.map((b) => [b.workerId, Number(b.balanceCents)]));
}

/**
 * How many workers the farm holds, as the server lists them.
 *
 * The cheapest honest answer to "did anything at all get written". `workers`
 * is the FIRST table the import writes — hundreds of lines before the
 * reconciliation runs — so a farm that still lists none after a refusal is a
 * farm the rollback really reached, rather than one that merely stopped early.
 */
async function serverWorkerCount(farm: Farm): Promise<number> {
  const body = await farm.http.request<{ items?: unknown[] }>("/v1/workers", {
    query: { includeDeleted: true },
  });
  return body.items?.length ?? 0;
}

// ---- Reporting -----------------------------------------------------------

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(2);
const secs = (ms: number) => (ms / 1000).toFixed(1);
const pesos = (cents: number) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 })
    .format(cents / 100);

function reportOutcome(o: SeasonImportOutcome): void {
  log(`  status      : ${o.status}`);
  log(`  rows        : ${o.rows.toLocaleString("es-CO")}`);
  log(`  size        : ${mb(o.bytes)} MB`);
  log(`  duration    : ${secs(o.durationMs)} s`);
  if (o.error) log(`  error       : ${o.error.code} — ${o.error.message}`);
  if (o.problems.length) log(`  problems    : ${o.problems.slice(0, 5).join(" · ")}`);
  if (o.mismatches.length)
    log(
      `  mismatches  : ${o.mismatches
        .slice(0, 5)
        .map((m) => `${m.name ?? m.workerId}: tel ${m.phoneCents} / srv ${m.serverCents}`)
        .join(" · ")}`,
    );
  if (o.report) {
    const r = o.report;
    const line = (k: keyof SeasonImportReport) => {
      const c = r[k] as { written: number; skipped: number };
      return `${String(k)} ${c.written}/${c.skipped}`;
    };
    log(
      `  escritas/ya : ${(
        [
          "workers",
          "plots",
          "crops",
          "weekPrices",
          "workRecords",
          "settlements",
          "settlementItems",
          "ledger",
        ] as const
      )
        .map(line)
        .join("  ")}`,
    );
    log(`  saldos ok   : ${r.balancesChecked}   líneas vivas: ${r.liveItems}`);
  }
}

let failures = 0;
function check(ok: boolean, what: string): void {
  log(`  ${ok ? "✔" : "✘"} ${what}`);
  if (!ok) failures++;
}

// ---- 1. The whole move ---------------------------------------------------

async function rehearsalFull(): Promise<void> {
  rule("1. THE WHOLE MOVE, against real Postgres");

  const t0 = Date.now();
  const phone = buildSeason(PICKUPS);
  log(`  season built in ${secs(Date.now() - t0)} s`);
  log(`  ${JSON.stringify(phone.shape)}`);

  const farm = await freshFarm("full");
  log(`  new farm    : ${farm.farmId}`);
  const importer = await handset(farm, phone.repo);

  const preview = importer.preview();
  const problems = verifySeasonExport(preview);
  check(problems.length === 0, `the local check passes (${problems.length} problems)`);
  const input = toImportInput(preview);

  log("");
  log(`  WHAT IS ABOUT TO GO UP, in what the owner understands:`);
  log(`    ${preview.totals.workers} pickers · ${preview.totals.workRecords.toLocaleString("es-CO")} weighings · ${phone.shape.weeks} weeks`);
  log(`    ${preview.totals.kg.toLocaleString("es-CO")} kg · ${preview.totals.settlements} settlements (${preview.totals.settlementItems.toLocaleString("es-CO")} lines)`);
  log(`    earned ${pesos(preview.totals.earnedCents)} · paid ${pesos(preview.totals.paidCents)} · balance ${pesos(preview.totals.balanceCents)}`);
  log(`    ${rowsOf(input).toLocaleString("es-CO")} rows · ${mb(byteLengthOf(input))} MB in a single upload`);
  log(`    from ${preview.totals.firstDay} to ${preview.totals.lastDay}`);
  log("");

  const outcome = await importer.run({
    onProgress: (p) => log(`  … ${p.phase} ${p.rows ? `${p.rows} rows` : ""} ${p.bytes ? `${mb(p.bytes)} MB` : ""}`),
  });
  reportOutcome(outcome);

  check(seasonWasImported(outcome), "the season ended up on the server");
  check(outcome.status === "imported", "and this call wrote it, not an earlier one");
  check(
    outcome.durationMs < SEASON_IMPORT_TIMEOUT_MS,
    `it fitted the deadline (${secs(outcome.durationMs)} s of ${SEASON_IMPORT_TIMEOUT_MS / 60000} min)`,
  );
  check(
    outcome.report?.balancesChecked === preview.reconciliation.balances.length,
    `the server compared all ${preview.reconciliation.balances.length} balances`,
  );

  // The half the import cannot prove about itself: read it back out.
  const server = await serverBalances(farm);
  let compared = 0;
  let off = 0;
  for (const b of preview.reconciliation.balances) {
    const there = server.get(b.workerId);
    if (there === undefined) {
      off++;
      log(`    ✘ ${b.workerId}: the server does not have them`);
      continue;
    }
    compared++;
    if (there !== b.balanceCents) {
      off++;
      log(`    ✘ ${b.workerId}: phone ${b.balanceCents} / server ${there}`);
    }
  }
  check(
    off === 0 && compared === preview.reconciliation.balances.length,
    `the ${compared} balances read BACK from the server agree to the cent`,
  );

  const there = await serverWorkerCount(farm);
  log(`  pickers the server says it has: ${there}`);
  check(there === preview.totals.workers, "and they are the same ones that left the phone");

  phone.db.close();

  log("");
  log(`  REHEARSAL FIGURES:`);
  log(`    weighings ${preview.totals.workRecords.toLocaleString("es-CO")}`);
  log(`    rows      ${outcome.rows.toLocaleString("es-CO")}`);
  log(`    size      ${mb(outcome.bytes)} MB`);
  log(`    upload    ${secs(outcome.durationMs)} s`);
  log(`    money     ${pesos(preview.totals.balanceCents)} in accounts`);
}

// ---- 2. The connection that dies halfway ---------------------------------

/**
 * A `fetch` that sends the body at a farm's speed, and optionally stops.
 *
 * Localhost is not the link this has to survive. A 12 MB body reaches a server
 * on the same machine in under a second, so "cut the socket after a second and
 * a half" would cut it after the upload had already finished — and the test
 * would be rehearsing a lost ANSWER while claiming to rehearse a lost
 * CONNECTION. Those are different failures with different consequences and the
 * whole question is which one a retry is safe after.
 *
 * So the body is turned into a stream and dripped at `kbPerSec`, which is also
 * what makes the timing on this rehearsal mean anything: it is the shape of the
 * upload `SEASON_IMPORT_TIMEOUT_MS` was sized against, and it is what the
 * server's own rolling 60 s read deadline exists to tolerate. `cutAfterBytes`
 * then stops the drip partway, mid-body, with the server still reading.
 */
function farmLink(opts: { kbPerSec: number; cutAfterBytes?: number }): typeof fetch {
  return (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : null;
    if (!raw) return globalThis.fetch(input, init);

    const bytes = new TextEncoder().encode(raw);
    const chunk = Math.max(1024, Math.floor(opts.kbPerSec * 1024 * 0.1)); // 100 ms of link
    const inner = new AbortController();
    init?.signal?.addEventListener("abort", () => inner.abort());

    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= bytes.length) {
          controller.close();
          return;
        }
        if (opts.cutAfterBytes !== undefined && sent >= opts.cutAfterBytes) {
          // The uplink drops. Not a polite EOF — the socket goes away with the
          // server still waiting for the rest of a body it has half of.
          inner.abort();
          controller.error(new Error("the link dropped"));
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
        const end = Math.min(sent + chunk, bytes.length);
        controller.enqueue(bytes.subarray(sent, end));
        sent = end;
      },
    });

    return globalThis.fetch(input, {
      ...init,
      body,
      signal: inner.signal,
      // Node refuses a streamed request body without it.
      duplex: "half",
    } as RequestInit);
  };
}

async function rehearsalDrop(): Promise<void> {
  rule("2. THE LINK THAT DROPS HALFWAY, and the retry");

  const phone = buildSeason(PICKUPS);
  const farm = await freshFarm("drop");
  log(`  new farm    : ${farm.farmId}`);

  // First attempt: a 1 MB/s link that dies after 3 MB, with the server still
  // reading. The body is genuinely half up when it goes.
  const dying = await handset(farm, phone.repo, {
    fetchImpl: farmLink({ kbPerSec: 1024, cutAfterBytes: 3_000_000 }),
  });
  const before = fingerprint(phone.db);
  const first = await dying.run();
  reportOutcome(first);
  check(first.status === "failed", "the cut attempt is reported as failed");
  check(
    fingerprint(phone.db) === before,
    "and the phone is bit for bit exactly what it was before",
  );

  const afterFail = await serverBalances(farm).catch(() => new Map<string, number>());
  check(afterFail.size === 0, "the server was not left with half a payroll");

  // Second attempt, on a link that holds.
  const healthy = await handset(farm, phone.repo);
  const second = await healthy.run();
  reportOutcome(second);
  check(seasonWasImported(second), "the retry uploads the whole season");
  check(second.status === "imported", "and it writes it: the cut had left nothing behind");

  const server = await serverBalances(farm);
  const phoneBalances = healthy.preview().reconciliation.balances;
  const off = phoneBalances.filter((b) => server.get(b.workerId) !== b.balanceCents);
  check(off.length === 0, `the ${phoneBalances.length} balances agree after the retry`);

  // And a third, to prove the retry after a SUCCESS is free too.
  const third = await healthy.run();
  check(
    third.status === "already-imported",
    "a third attempt writes nothing new (already-imported)",
  );

  phone.db.close();
}

/** Every row of every table the farm owns, as one string. `import_runs` is the
 *  one table an import may write, so it is left out. */
function fingerprint(db: DatabaseSync): string {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT IN ('import_runs','sqlite_sequence') ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const parts: string[] = [];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    parts.push(`${t}:${rows.map((r) => JSON.stringify(r)).sort().join("|")}`);
  }
  return parts.join("\n");
}

// ---- 3. A balance that does not add up -----------------------------------

/**
 * One centavo, on purpose, past the phone's own check.
 *
 * `verifySeasonExport` would refuse this before a byte left, which is correct
 * and is already tested. What is being rehearsed here is the OTHER guard — the
 * server's, inside the transaction, against real Postgres — so the tampering
 * happens below the importer, on the wire value itself. That is the only way
 * to find out whether a refusal really rolls a 12 MB import back or leaves
 * half a payroll behind.
 */
async function rehearsalMismatch(): Promise<void> {
  rule("3. A BALANCE THAT DOES NOT ADD UP: the whole import is aborted");

  const phone = buildSeason(Math.min(PICKUPS, 4000));
  const farm = await freshFarm("mismatch");
  log(`  new farm    : ${farm.farmId}`);

  const deviceId = phone.repo.sync.identity().deviceId;
  await farm.session.login(farm.email, farm.password, deviceId);
  phone.repo.sync.claimFarm(farm.farmId);
  const http = new HttpClient({ baseUrl: BASE, session: farm.session });
  const rest = new RestTransport({ http });

  const importer = new SeasonImporter({ repo: phone.repo, transport: rest });
  const input = toImportInput(importer.preview());

  // One centavo, on one worker, out of twenty-four.
  const victim = input.balances[3];
  const tampered: SeasonImportInput = {
    ...input,
    balances: input.balances.map((b) =>
      b.workerId === victim.workerId ? { ...b, balanceCents: b.balanceCents + 1 } : b,
    ),
  };
  log(`  ${input.balances.length} balances, one of them falsified by 1 centavo`);
  log(`  ${rowsOf(tampered).toLocaleString("es-CO")} rows · ${mb(byteLengthOf(tampered))} MB`);

  let rejected: ApiError | null = null;
  try {
    await rest.importSeason(tampered);
  } catch (e) {
    rejected = e instanceof ApiError ? e : null;
    if (!rejected) throw e;
  }

  check(rejected !== null, "the server refused the import");
  check(rejected?.status === 409, `and with a 409 (it was ${rejected?.status})`);
  check(rejected?.code === "IMPORT_MISMATCH", `code IMPORT_MISMATCH (it was ${rejected?.code})`);
  const named = (rejected?.details?.balances as unknown[] | undefined) ?? [];
  check(named.length > 0, `and it names who: ${JSON.stringify(named.slice(0, 2))}`);

  // The property the whole plan rests on: nothing was written.
  const server = await serverBalances(farm);
  check(server.size === 0, `the farm is still empty after the refusal (${server.size} balances)`);
  const workers = await serverWorkerCount(farm);
  check(workers === 0, `not one single picker written (${workers})`);

  // And the honest payload goes up afterwards, whole.
  const good = await importer.run();
  reportOutcome(good);
  check(seasonWasImported(good), "with the cause fixed, the whole season goes up");

  phone.db.close();
}

// ---- 4. The second import ------------------------------------------------

async function rehearsalSecond(): Promise<void> {
  rule("4. THE SECOND IMPORT over a farm that already received one");

  const phone = buildSeason(Math.min(PICKUPS, 6000));
  const farm = await freshFarm("second");
  log(`  new farm    : ${farm.farmId}`);
  const importer = await handset(farm, phone.repo);

  const first = await importer.run();
  check(first.status === "imported", "the first one uploads");
  const wrote = first.report!;

  // A DIFFERENT handset, on the same farm, offering the same season. This is
  // the case a naive import turns into a second parcela per retry.
  const second = await importer.run();
  reportOutcome(second);
  check(second.status === "already-imported", "the second writes nothing");
  check(
    (second.report?.workers.written ?? -1) === 0 &&
      (second.report?.workRecords.written ?? -1) === 0 &&
      (second.report?.ledger.written ?? -1) === 0,
    "written = 0 on workers, weighings and movements",
  );
  check(
    second.report?.workRecords.skipped === wrote.workRecords.written,
    `and skipped = what the first one wrote (${second.report?.workRecords.skipped} = ${wrote.workRecords.written})`,
  );
  check(
    second.report?.plots.written === 0 && second.report?.crops.written === 0,
    "and it did not invent a second parcela per lote",
  );

  const server = await serverBalances(farm);
  const phoneBalances = importer.preview().reconciliation.balances;
  const off = phoneBalances.filter((b) => server.get(b.workerId) !== b.balanceCents);
  check(off.length === 0, "the balances still agree after the second");

  phone.db.close();
}

// ---- Runner --------------------------------------------------------------

async function main(): Promise<void> {
  log(`Rehearsal of the move against ${BASE}`);
  log(`Weighings: ${PICKUPS.toLocaleString("es-CO")}`);

  const only = process.argv[2];
  const all: Record<string, () => Promise<void>> = {
    full: rehearsalFull,
    drop: rehearsalDrop,
    mismatch: rehearsalMismatch,
    second: rehearsalSecond,
  };
  for (const [name, fn] of Object.entries(all)) {
    if (only && only !== name) continue;
    await fn();
  }

  rule(failures === 0 ? "TODO CUADRA" : `${failures} COMPROBACIONES FALLARON`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("FALLÓ:", e);
  process.exitCode = 1;
});
