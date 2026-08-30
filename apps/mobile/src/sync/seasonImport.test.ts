/**
 * The mudanza, tested against what actually goes wrong on a Tuesday morning.
 *
 * `docs/sincronizacion.md` §8 fase 4 gives this exactly one hour, with
 * somebody standing there, on a farm that is mid-harvest. The cases below are
 * the four that would ruin it:
 *
 *   - the upload dies halfway and has to be started again;
 *   - the server derives a different balance and the whole thing has to come
 *     back out, not half of it;
 *   - the phone is asked to do it a second time;
 *   - the season is eighteen thousand weighings and the hour is real.
 *
 * Every one of them runs against the REAL repository over `node:sqlite` — the
 * real v5→v7 migration, the real uuids, the real `BALANCE_SQL`, the real
 * outbox triggers — with a fake server that behaves like the one §8 describes:
 * it stages, it derives its own figures, and it refuses. A test that mocked
 * the repository would be checking that a mock does what it was told, and the
 * property being claimed here is about a season nobody can re-enter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { ApiError, DEFAULT_TIMEOUT_MS, HttpClient, type Session } from "./http.ts";
import { RestTransport } from "./restTransport.ts";
import { nodeSqlite } from "../data/nodeSqlite.ts";
import { createSqliteRepository } from "../data/sqliteRepository.ts";
import type { Repository } from "../data/repository.ts";
import { isUuidV7 } from "../../../../packages/shared/src/uuid.ts";
import {
  seasonImportId,
  verifySeasonExport,
  type SeasonExport,
} from "./seasonExport.ts";
import {
  byteLengthOf,
  SEASON_IMPORT_TIMEOUT_MS,
  SeasonImporter,
  seasonWasImported,
  toImportInput,
  type ImportCounts,
  type ImportLedgerInput,
  type SeasonImportInput,
  type SeasonImportProgress,
  type SeasonImportReport,
  type SeasonImportTransport,
} from "./seasonImport.ts";

// ---- Small fixtures for the deadline tests at the bottom -----------------

/** A session that never expires and never refreshes. */
const fixedSession = (): Session => ({
  current: () => ({
    accessToken: "t",
    refreshToken: "r",
    expiresAt: Date.now() + 3600_000,
    farmId: "farm",
    role: "owner",
  }),
  refresh: async () => {
    throw new Error("no refresh in this test");
  },
  clear: () => {},
});

const emptyCounts = (): ImportCounts => ({ written: 0, skipped: 0 });

const emptyReport = (): SeasonImportReport => ({
  workers: emptyCounts(),
  plots: emptyCounts(),
  crops: emptyCounts(),
  weekPrices: emptyCounts(),
  workRecords: emptyCounts(),
  settlements: emptyCounts(),
  settlementItems: emptyCounts(),
  ledger: emptyCounts(),
  balancesChecked: 0,
  liveItems: 0,
});

/**
 * A `fetch` that takes `ms` to answer and ABORTS like the real one.
 *
 * Honouring the signal is the whole point: a fake that resolves regardless of
 * the AbortController would pass a test about deadlines while proving nothing,
 * because the deadline's only job is to make the socket give up.
 */
const answersAfter =
  (ms: number, answer: (init?: RequestInit) => Response): typeof fetch =>
  (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(answer(init)), ms);
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });

/** The smallest thing the contract accepts, for tests about the wire itself. */
const anInput = (): SeasonImportInput => ({
  deviceId: "0192e6aa-0000-7000-8000-0000000000de",
  workers: [],
  plots: [],
  weekPrices: [],
  workRecords: [],
  settlements: [],
  ledger: [],
  balances: [],
});

// ---- A phone that has been in a farm for months --------------------------

/**
 * The schema the handset in production is actually on before any of this
 * ran. Copied rather than imported because it has to be frozen: the point of
 * the fixture is a database built by a version of the app that no longer
 * exists, and one that tracked `schema.ts` would stop being that.
 */
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

const iso = (ms: number) => new Date(ms).toISOString();
const SEASON_START = Date.UTC(2026, 1, 2, 11, 0, 0); // a Monday
const DAY = 86400000;

interface Phone {
  db: DatabaseSync;
  repo: Repository;
  pickups: number;
}

/**
 * A season, then the upgrade the farm has already been through.
 *
 * The rows are written under the v5 schema and `repo.init()` runs the real
 * v6 and v7 migrations over them, which is the only way this fixture is worth
 * anything: the uuids the export sends are the ones `migrateToV6` minted from
 * each row's own instant, not ones a test made up.
 */
function aPhone(pickupCount = 400, opts: { farmId?: string } = {}): Phone {
  const db = new DatabaseSync(":memory:");
  db.exec(V5_SCHEMA);
  db.exec("BEGIN");

  const people = 12;
  const plots = 3;
  const person = db.prepare(
    "INSERT INTO people (name,lastName,documentType,docId,tag,createdAt) VALUES (?,?,'CC',?,?,?)",
  );
  for (let i = 1; i <= people; i++)
    person.run(`Persona${i}`, `Apellido${i}`, String(1000000 + i), `T${i}`, iso(SEASON_START));
  const plot = db.prepare(
    "INSERT INTO crops (name,type,variety,dimension,createdAt) VALUES (?,'Café','Castillo',2.5,?)",
  );
  for (let i = 1; i <= plots; i++) plot.run(`Lote ${i}`, iso(SEASON_START));

  const pk = db.prepare(
    "INSERT INTO pickups (personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?)",
  );
  const perDay = Math.max(1, Math.ceil(pickupCount / 120));
  const whenOf: number[] = [0];
  let made = 0;
  for (let d = 0; made < pickupCount; d++) {
    if (d % 7 === 6) continue; // Sunday off
    for (let k = 0; k < perDay && made < pickupCount; k++, made++) {
      const when = SEASON_START + d * DAY + Math.floor(k / 3) * 1000;
      whenOf.push(when);
      pk.run((made % people) + 1, (made % plots) + 1, 20 + (made % 60), iso(when), iso(when));
    }
  }

  // Every week settled and paid, which is what makes the ledger and the lock
  // worth reconciling at all.
  const st = db.prepare(
    `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,createdAt)
     VALUES (?,?,?,?,'open',?)`,
  );
  const li = db.prepare(
    `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
     VALUES (?,?,?,?,?,?)`,
  );
  const le = db.prepare(
    `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,createdAt)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const weeks = Math.ceil(whenOf.length / (people * 4));
  let next = 1;
  for (let w = 0; w < weeks; w++)
    for (let p = 1; p <= people && next < whenOf.length; p++) {
      const paidAt = SEASON_START + (w * 7 + 6) * DAY;
      const mine: number[] = [];
      for (let k = 0; k < 4 && next < whenOf.length; k++) mine.push(next++);
      const gross = mine.length * 40000;
      const sid = Number(
        st.run(p, iso(paidAt).slice(0, 10), iso(paidAt).slice(0, 10), gross, iso(paidAt))
          .lastInsertRowid,
      );
      for (const id of mine) li.run(sid, id, iso(paidAt).slice(0, 10), 50, 800, 40000);
      le.run(p, "devengo", gross, iso(paidAt).slice(0, 10), sid, null, iso(paidAt));
      // Not everybody is paid in full — a farm always owes somebody something,
      // and a reconciliation over a set of zero balances proves nothing.
      if (p % 3 !== 0)
        le.run(p, "pago", -gross, iso(paidAt).slice(0, 10), null, "efectivo", iso(paidAt + 60000));
    }

  // An advance handed over in the lote, so at least one worker is in the red.
  le.run(2, "anticipo", -25000, iso(SEASON_START + 3 * DAY).slice(0, 10), null, "efectivo", iso(SEASON_START + 3 * DAY));
  for (let w = 0; w < 6; w++)
    db.prepare("INSERT INTO cost_overrides (week, costPerUnit) VALUES (?, ?)").run(
      iso(SEASON_START + w * 7 * DAY).slice(0, 10),
      800 + w * 5,
    );
  db.exec("COMMIT");

  const repo = createSqliteRepository(nodeSqlite(db), { timezone: "America/Bogota" });
  repo.init();

  // Registered against a farm, which is fase 4's precondition: the phone is
  // talking to a server before anybody moves the season.
  repo.sync.claimFarm(opts.farmId ?? "farm-esperanza");

  return { db, repo, pickups: pickupCount };
}

const identityOf = (repo: Repository) => {
  const id = repo.sync.identity();
  return seasonImportId(id.farmId!, id.deviceId);
};

// ---- Proving the phone was not touched ----------------------------------

/**
 * Every row of every table the farm owns, as one string.
 *
 * `import_runs` is left out because it is the one table an import is allowed
 * to write, and `sqlite_sequence` follows it. Everything else — the weighings,
 * the ledger, the outbox, the sync cursor, the schema version — has to come
 * out byte for byte the same, whatever happened on the network.
 */
function fingerprint(db: DatabaseSync): string {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT IN ('import_runs','sqlite_sequence')
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  const parts: string[] = [
    `user_version=${(db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version}`,
  ];
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    parts.push(
      `${t}:${rows
        .map((r) => JSON.stringify(r))
        .sort()
        .join("|")}`,
    );
  }
  return parts.join("\n");
}
// ---- A server that writes, derives and refuses --------------------------
//
// It behaves like `store.ImportSeason`: every insert is keyed by the id the
// handset sent and reports `written` or `skipped`; the reconciliation runs
// before the commit; and a refusal writes nothing at all. Getting that last
// part wrong in the fake would make every "nothing was written" assertion
// below vacuous, so the refusal path deliberately never touches `rows`.

interface FakeServerOptions {
  /** Break the socket after the request was sent — a lost ANSWER, not a lost
   *  write. This is the retry case that actually costs money if it is wrong. */
  loseAnswerAfterWriting?: boolean;
  /** Break the socket before anything is written. */
  dieBeforeWriting?: { code: string; message: string };
  /** Drop one ledger row on the way in: the server's derivation then differs. */
  loseLedgerId?: string;
}

class FakeImportServer {
  /** The farm's tables: "entity:id" → row. Only a clean import adds to this. */
  rows = new Map<string, object>();
  requests = 0;
  /** Bodies as they went over the wire, so a test can inspect the JSON. */
  bodies: SeasonImportInput[] = [];
  opts: FakeServerOptions;

  constructor(opts: FakeServerOptions = {}) {
    this.opts = opts;
  }

  of<T>(entity: string): T[] {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${entity}:`))
      .map(([, v]) => v as T);
  }

  transport(): SeasonImportTransport {
    return {
      importSeason: async (input: SeasonImportInput): Promise<SeasonImportReport> => {
        this.requests++;
        this.bodies.push(input);
        if (this.opts.dieBeforeWriting)
          throw new ApiError(
            this.opts.dieBeforeWriting.code,
            this.opts.dieBeforeWriting.message,
            0,
          );

        // Everything is staged in a local map first, exactly as the real one
        // works inside a transaction: nothing reaches `this.rows` until the
        // reconciliation has passed.
        const staged = new Map<string, object>();
        const counts: Record<string, ImportCounts> = {};
        const put = (entity: string, id: string, row: object) => {
          const c = (counts[entity] ??= { written: 0, skipped: 0 });
          const key = `${entity}:${id}`;
          if (this.rows.has(key) || staged.has(key)) {
            // ON CONFLICT (id) DO NOTHING. This is §4.1's first layer and the
            // only reason a retry is free.
            c.skipped++;
            return;
          }
          staged.set(key, row);
          c.written++;
        };

        for (const w of input.workers) put("workers", w.id, w);
        for (const p of input.plots) {
          put("plots", p.cropId, p);
          put("crops", p.cropId, p);
        }
        for (const w of input.weekPrices) put("weekPrices", w.weekStart, w);
        for (const r of input.workRecords) put("workRecords", r.id, r);
        for (const s of input.settlements) {
          put("settlements", s.id, s);
          for (const i of s.items) put("settlementItems", i.id, i);
        }
        for (const e of input.ledger) {
          if (e.id === this.opts.loseLedgerId) continue;
          put("ledger", e.id, e);
        }

        // §8 fase 3 query 1, derived from what was received and compared to
        // what the handset declared. `reconcileImport` in `store/import.go`.
        const derived = new Map<string, number>();
        const ledgerRows = [
          ...[...staged.entries()], ...[...this.rows.entries()],
        ].filter(([k]) => k.startsWith("ledger:"));
        for (const [, raw] of ledgerRows) {
          const e = raw as unknown as ImportLedgerInput;
          derived.set(e.workerId, (derived.get(e.workerId) ?? 0) + e.amountCents);
        }
        const mismatches = input.balances
          .filter((b) => (derived.get(b.workerId) ?? 0) !== b.balanceCents)
          .map((b) => ({
            workerId: b.workerId,
            phoneCents: b.balanceCents,
            serverCents: derived.get(b.workerId) ?? 0,
            differenceCents: (derived.get(b.workerId) ?? 0) - b.balanceCents,
          }));
        if (mismatches.length)
          // 409, and the transaction never commits. `staged` is discarded.
          throw new ApiError(
            "IMPORT_MISMATCH",
            "the imported balances do not match what the server derives; nothing was written",
            409,
            { balances: mismatches },
          );

        // The lock: as many live lines as the handset sent, not fewer.
        const expectedLive = input.settlements.reduce(
          (n, s) => n + s.items.filter((i) => i.voidedAt === null).length,
          0,
        );
        const live = [...staged.keys(), ...this.rows.keys()].filter((k) =>
          k.startsWith("settlementItems:"),
        ).length;
        if (live < expectedLive)
          throw new ApiError("IMPORT_MISMATCH", "fewer live settlement lines survived", 409, {
            expectedLiveItems: expectedLive,
            liveItems: live,
          });

        // COMMIT.
        for (const [k, v] of staged) this.rows.set(k, v);

        const report: SeasonImportReport = {
          workers: counts.workers ?? empty(),
          plots: counts.plots ?? empty(),
          crops: counts.crops ?? empty(),
          weekPrices: counts.weekPrices ?? empty(),
          workRecords: counts.workRecords ?? empty(),
          settlements: counts.settlements ?? empty(),
          settlementItems: counts.settlementItems ?? empty(),
          ledger: counts.ledger ?? empty(),
          balancesChecked: input.balances.length,
          liveItems: live,
        };

        // The answer never arrives. The write HAPPENED; the phone does not
        // know it. This is the case that decides whether a retry is safe.
        if (this.opts.loseAnswerAfterWriting)
          throw new ApiError("TIMEOUT", "la petición tardó demasiado", 0);

        return report;
      },
    };
  }
}

const empty = (): ImportCounts => ({ written: 0, skipped: 0 });

const importerFor = (phone: Phone, server: FakeImportServer): SeasonImporter =>
  new SeasonImporter({ repo: phone.repo, transport: server.transport() });

// ---- What it exports ----------------------------------------------------

test("exporta la temporada entera con los uuid que ya tenía el teléfono", () => {
  const phone = aPhone(400);
  const x = phone.repo.sync.seasonExport(identityOf(phone.repo), "2026-08-29T12:00:00.000Z");

  // Counts, table by table, against the database itself.
  const count = (t: string) =>
    Number((phone.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  assert.equal(x.workers.length, count("people"));
  assert.equal(x.plots.length, count("crops"));
  assert.equal(x.weekPrices.length, count("cost_overrides"));
  assert.equal(x.workRecords.length, count("pickups"));
  assert.equal(x.settlements.length, count("settlements"));
  assert.equal(
    x.settlements.reduce((n, s) => n + s.items.length, 0),
    count("settlement_items"),
  );
  assert.equal(x.ledger.length, count("ledger"));

  // The ids are the phone's own, minted by the v6 migration and not by this.
  const uuids = (t: string) =>
    new Set(
      (phone.db.prepare(`SELECT uuid FROM ${t}`).all() as { uuid: string }[]).map((r) => r.uuid),
    );
  assert.deepEqual(new Set(x.workers.map((w) => w.id)), uuids("people"));
  assert.deepEqual(new Set(x.workRecords.map((r) => r.id)), uuids("pickups"));
  assert.deepEqual(new Set(x.ledger.map((e) => e.id)), uuids("ledger"));
  assert.ok(x.workRecords.every((r) => isUuidV7(r.id)));

  // §8: `plot_crops` inherits the crop's uuid, because that is where the
  // weighings point. The plot itself has no id here — the server mints it.
  assert.deepEqual(new Set(x.plots.map((p) => p.plotCropId)), uuids("crops"));

  // The money is not remapped: a line still names the same weighing it named
  // on the phone. This is the correspondence §1.4 is about.
  const pickupIds = new Set(x.workRecords.map((r) => r.id));
  for (const s of x.settlements)
    for (const i of s.items) assert.ok(pickupIds.has(i.payableId));

  // And the whole thing agrees with itself.
  assert.deepEqual(verifySeasonExport(x), []);
});

test("el saldo que viaja es el que el teléfono le muestra a cada persona", () => {
  const phone = aPhone(200);
  const x = phone.repo.sync.seasonExport(identityOf(phone.repo), "2026-08-29T12:00:00.000Z");

  // Every balance in the payload against the repository's own BALANCE_SQL —
  // the query behind the number on the worker's screen. If these two can
  // differ, the verification is checking something nobody is looking at.
  for (const b of x.reconciliation.balances) {
    const person = phone.repo.sync.personByUuid(b.workerId);
    assert.ok(person, "every exported balance names somebody the phone knows");
    assert.equal(
      phone.repo.payments.balance(person.id).balanceCents,
      b.balanceCents,
      `saldo de ${person.name}`,
    );
  }
  assert.ok(
    x.reconciliation.balances.some((b) => b.balanceCents !== 0),
    "a farm where everybody is square proves nothing",
  );
});

test("el teléfono se niega a exportar una temporada con filas sin nombre", () => {
  const phone = aPhone(50);
  // A row the v6 backfill somehow missed. §1.3 says `missing = 0`; a phone
  // that exported anyway would hand the server a season short by exactly the
  // rows nobody looked at.
  phone.db.exec("UPDATE pickups SET uuid = NULL WHERE id = 1");

  assert.throws(
    () => phone.repo.sync.seasonExport("x", "2026-08-29T12:00:00.000Z"),
    /MISSING_UUIDS/,
  );
});

// ---- The check that has to fail before anything leaves ------------------

test("una verificación que no cuadra consigo misma se detecta aquí, no en el servidor", () => {
  const phone = aPhone(120);
  const good = phone.repo.sync.seasonExport("x", "2026-08-29T12:00:00.000Z");
  assert.deepEqual(verifySeasonExport(good), []);

  // A ledger entry the exporter dropped: the classic shape of a join bug. The
  // server could never catch this, because the balances it is handed and the
  // rows it is handed would agree with each other — and both would be wrong.
  const holed: SeasonExport = { ...good, ledger: good.ledger.slice(1) };
  const problems = verifySeasonExport(holed);
  assert.ok(problems.length > 0, "a missing movement has to be noticed");
  assert.ok(problems.some((p) => p.includes("saldo de")));

  // Two live lines claiming the same weighing: `ux_items_pickup_live` restated
  // on the wire, and the one property that stops work being paid twice.
  const first = good.settlements.find((s) => s.items.some((i) => i.voidedAt === null))!;
  const claimed = first.items.find((i) => i.voidedAt === null)!;
  const doubled: SeasonExport = {
    ...good,
    settlements: good.settlements.map((s) =>
      s.id === first.id
        ? {
            ...s,
            items: [...s.items, { ...claimed, id: `${claimed.id}-bis` }],
          }
        : s,
    ),
  };
  assert.ok(
    verifySeasonExport(doubled).some((p) => p.includes("dos liquidaciones vivas")),
  );
});

test("un envío que no cuadra no llega a salir del teléfono", async () => {
  const phone = aPhone(80);
  const server = new FakeImportServer();

  // A repository whose export has a hole in it, standing in for the exporter
  // bug the local check exists to catch.
  const holed: Repository = {
    ...phone.repo,
    sync: {
      ...phone.repo.sync,
      seasonExport: (importId, at) => {
        const x = phone.repo.sync.seasonExport(importId, at);
        return { ...x, ledger: x.ledger.slice(1) };
      },
    },
  };

  const outcome = await new SeasonImporter({
    repo: holed,
    transport: server.transport(),
  }).run();

  assert.equal(outcome.status, "refused");
  assert.equal(seasonWasImported(outcome), false);
  assert.ok(outcome.problems.length > 0);
  assert.equal(server.requests, 0, "the request was never made");
  assert.equal(server.rows.size, 0);
});

// ---- Cut in half, and started again -------------------------------------

test("una importación cuya respuesta se pierde no duplica nada al reintentarla", async () => {
  // The worst case of §8 fase 4 and the reason idempotence is not optional:
  // the server WROTE the season and the answer never got back. The phone has
  // no way to tell that apart from a request that never arrived, so it does
  // the only thing it can do — send it again — and the property being tested
  // is that the farm does not end up with two of everything.
  const phone = aPhone(400);
  const before = fingerprint(phone.db);
  const owedBefore = phone.repo.sync.pendingCount();

  const server = new FakeImportServer({ loseAnswerAfterWriting: true });
  const first = await importerFor(phone, server).run();

  assert.equal(first.status, "failed");
  assert.equal(seasonWasImported(first), false);
  assert.equal(first.error?.code, "TIMEOUT");
  const written = server.rows.size;
  assert.ok(written > 0, "the server did write it: that is the whole trap");
  assert.equal(
    fingerprint(phone.db),
    before,
    "and the phone did not move, so there is nothing to undo",
  );
  assert.equal(phone.repo.sync.pendingCount(), owedBefore, "the outbox did not move");

  // The retry, against the same server, which is now answering again.
  server.opts.loseAnswerAfterWriting = false;
  const second = await importerFor(phone, server).run();

  assert.equal(second.status, "already-imported", second.error?.message ?? "");
  assert.equal(seasonWasImported(second), true);
  assert.equal(server.rows.size, written, "the farm did not grow a second season");
  assert.equal(second.report!.workRecords.written, 0);
  assert.ok(second.report!.workRecords.skipped > 0, "all of it was already there");

  // One row per uuid on the server, matching the phone exactly.
  const count = (t: string) =>
    Number((phone.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  assert.equal(server.of("workers").length, count("people"));
  assert.equal(server.of("workRecords").length, count("pickups"));
  assert.equal(server.of("ledger").length, count("ledger"));
  assert.equal(server.of("settlements").length, count("settlements"));
  assert.equal(server.of("settlementItems").length, count("settlement_items"));

  assert.equal(fingerprint(phone.db), before);
  assert.equal(phone.repo.sync.pendingCount(), owedBefore);
});

test("una importación que se corta antes de escribir se reintenta y escribe entera", async () => {
  const phone = aPhone(300);
  const before = fingerprint(phone.db);

  const dying = new FakeImportServer({
    dieBeforeWriting: { code: "NETWORK", message: "sin conexión" },
  });
  const first = await importerFor(phone, dying).run();
  assert.equal(first.status, "failed");
  assert.equal(dying.rows.size, 0, "nothing was written");
  assert.equal(fingerprint(phone.db), before);

  // Whether the retry meets the same server or a fresh one, the answer is the
  // same season and no duplicates — because the ids are the phone's.
  const alive = new FakeImportServer();
  const second = await importerFor(phone, alive).run();
  assert.equal(second.status, "imported", second.error?.message ?? "");

  const count = (t: string) =>
    Number((phone.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  assert.equal(alive.of("workRecords").length, count("pickups"));
  assert.equal(alive.of("ledger").length, count("ledger"));
  assert.equal(fingerprint(phone.db), before);
});

test("tres intentos seguidos dejan exactamente una temporada", async () => {
  // §8 fase 3: «Se repite hasta que salga limpio.» That sentence is only safe
  // if repeating is free, so it is worth pinning rather than assuming.
  const phone = aPhone(200);
  const server = new FakeImportServer();

  const a = await importerFor(phone, server).run();
  const size = server.rows.size;
  const b = await importerFor(phone, server).run();
  const c = await importerFor(phone, server).run();

  assert.equal(a.status, "imported");
  assert.equal(b.status, "already-imported");
  assert.equal(c.status, "already-imported");
  assert.equal(server.rows.size, size, "one season, three attempts");
  assert.equal(server.requests, 3);
  // And the record shows all three, which is what somebody reads three weeks
  // later when a reclamo turns up.
  assert.deepEqual(
    phone.repo.sync.importRuns(10).map((r) => r.status),
    ["already-imported", "already-imported", "imported"],
  );
});

// ---- A saldo that does not add up ---------------------------------------

test("un saldo que no coincide al centavo aborta la importación entera", async () => {
  const phone = aPhone(300);
  const before = fingerprint(phone.db);

  // The server loses one movement of money on the way in — which is exactly
  // what the check is for. Its derived balance for that worker is then short
  // by the amount of the lost row.
  const x = phone.repo.sync.seasonExport(identityOf(phone.repo), "2026-08-29T12:00:00.000Z");
  const lost = x.ledger.find((e) => e.kind === "pago")!;
  const server = new FakeImportServer({ loseLedgerId: lost.id });

  const outcome = await importerFor(phone, server).run();

  assert.equal(outcome.status, "rejected");
  assert.equal(seasonWasImported(outcome), false);
  assert.equal(outcome.error?.code, "IMPORT_MISMATCH");

  assert.equal(outcome.mismatches.length, 1, "one worker, named");
  assert.equal(outcome.mismatches[0]!.workerId, lost.workerId);
  assert.equal(
    outcome.mismatches[0]!.serverCents - outcome.mismatches[0]!.phoneCents,
    -lost.amountCents,
    "off by exactly the movement that went missing",
  );
  // §7.3's rule applied here too: a card without a name is not a card.
  assert.ok(outcome.mismatches[0]!.name, "the worker is named, not a uuid");

  // NOTHING was written. Not the workers, not the weighings, not half the
  // ledger — media nómina importada es peor que ninguna.
  assert.equal(server.rows.size, 0, "the whole transaction rolled back");
  assert.equal(fingerprint(phone.db), before, "and the phone did not move either");

  // The refusal is on the record, so somebody can see what happened at ten
  // past six the following week.
  const run = phone.repo.sync.importRuns(1)[0]!;
  assert.equal(run.status, "rejected");
  assert.match(String(run.error), /IMPORT_MISMATCH/);
});

test("después de un rechazo, arreglar la causa y reintentar sube la temporada entera", async () => {
  // The other half of the previous case: a rejection is not a dead end, and
  // the retry has to write EVERYTHING — nothing was left behind by the
  // attempt that failed.
  const phone = aPhone(200);
  const x = phone.repo.sync.seasonExport(identityOf(phone.repo), "2026-08-29T12:00:00.000Z");
  const lost = x.ledger.find((e) => e.kind === "pago")!;

  const broken = new FakeImportServer({ loseLedgerId: lost.id });
  assert.equal((await importerFor(phone, broken).run()).status, "rejected");
  assert.equal(broken.rows.size, 0);

  broken.opts.loseLedgerId = undefined;
  const fixed = await importerFor(phone, broken).run();

  assert.equal(fixed.status, "imported");
  const count = (t: string) =>
    Number((phone.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  assert.equal(broken.of("ledger").length, count("ledger"));
  assert.equal(fixed.report!.balancesChecked, x.reconciliation.balances.length);
});

test("un centavo de diferencia basta, y lo caza el teléfono antes de salir", async () => {
  // The rule is "al centavo", and this is what that costs: one cent, on one
  // worker, in a season of hundreds of movements. It is caught by the LOCAL
  // check rather than by the server, which is the better of the two places —
  // the season never leaves the handset — and the assertion is that both the
  // catching and the not-writing happen.
  const phone = aPhone(120);
  const victim = phone.repo.sync
    .seasonExport("x", "2026-08-29T12:00:00.000Z")
    .reconciliation.balances.find((b) => b.balanceCents !== 0)!;

  const offByOne: Repository = {
    ...phone.repo,
    sync: {
      ...phone.repo.sync,
      seasonExport: (importId, at) => {
        const real = phone.repo.sync.seasonExport(importId, at);
        return {
          ...real,
          reconciliation: {
            ...real.reconciliation,
            balances: real.reconciliation.balances.map((b) =>
              b.workerId === victim.workerId
                ? { ...b, balanceCents: b.balanceCents + 1 }
                : b,
            ),
          },
        };
      },
    },
  };

  const server = new FakeImportServer();
  const outcome = await new SeasonImporter({
    repo: offByOne,
    transport: server.transport(),
  }).run();

  assert.equal(outcome.status, "refused");
  assert.ok(outcome.problems.some((p) => p.includes("saldo de")));
  assert.equal(server.requests, 0, "the request was never made");
  assert.equal(server.rows.size, 0);
});

// ---- Doing it twice, and never starting -------------------------------

test("una segunda importación sobre una finca que ya la recibió no escribe nada nuevo", async () => {
  const phone = aPhone(400);
  const server = new FakeImportServer();

  const first = await importerFor(phone, server).run();
  assert.equal(first.status, "imported");
  const written = server.rows.size;
  assert.ok(written > 0);

  // Somebody presses it again — the button is still there, and on the morning
  // of fase 4 somebody will.
  const second = await importerFor(phone, server).run();

  assert.equal(second.status, "already-imported");
  assert.equal(
    seasonWasImported(second),
    true,
    "it IS imported: saying otherwise would be a lie",
  );
  assert.equal(server.rows.size, written, "the farm did not grow a second season");
  // Every table came back entirely skipped, which is the contract's own way of
  // answering "did the retry do anything".
  const r = second.report!;
  for (const [name, c] of Object.entries(r).filter(
    ([, v]) => typeof v === "object",
  ) as [string, ImportCounts][])
    assert.equal(c.written, 0, `${name} wrote something on a re-run`);
});

test("una importación que ni siquiera sale queda registrada y no toca nada", async () => {
  const phone = aPhone(60);
  const before = fingerprint(phone.db);
  const server = new FakeImportServer({
    dieBeforeWriting: { code: "TOKEN_EXPIRED", message: "hay que volver a entrar" },
  });

  const outcome = await importerFor(phone, server).run();

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error?.code, "TOKEN_EXPIRED");
  assert.equal(fingerprint(phone.db), before);
  assert.equal(phone.repo.sync.importRuns(1)[0]!.status, "failed");
});

// ---- The body that actually goes on the wire ---------------------------

test("el cuerpo lleva exactamente los campos del contrato, ni uno más", async () => {
  // `handleImportSeason` decodes with `DisallowUnknownFields`. One extra
  // property — a `localDay` the trigger computes, a `weekStart` the server
  // derives — and the whole season comes back as a 400, after the upload.
  const phone = aPhone(120);
  const server = new FakeImportServer();
  await importerFor(phone, server).run();
  const body = server.bodies[0]!;

  assert.deepEqual(Object.keys(body).sort(), [
    "balances",
    "deviceId",
    "ledger",
    "plots",
    "settlements",
    "weekPrices",
    "workRecords",
    "workers",
  ]);
  assert.deepEqual(Object.keys(body.workRecords[0]!).sort(), [
    "cropId",
    "deletedAt",
    "deviceId",
    "id",
    "note",
    "occurredAt",
    "quantity",
    "workerId",
  ]);
  assert.deepEqual(Object.keys(body.ledger[0]!).sort(), [
    "amountCents",
    "createdAt",
    "date",
    "id",
    "kind",
    "method",
    "note",
    "reversesId",
    "settlementId",
    "workerId",
  ]);
  assert.deepEqual(Object.keys(body.plots[0]!).sort(), [
    "areaHa",
    "cropId",
    "cropType",
    "deletedAt",
    "name",
    "variety",
  ]);
  assert.deepEqual(Object.keys(body.settlements[0]!.items[0]!).sort(), [
    "amountCents",
    "id",
    "payableId",
    "priceCents",
    "quantity",
    "voidedAt",
    "weekStart",
  ]);

  // The ledger keeps its own sign: the route writes the row directly and the
  // database refuses a positive `pago`. §2.3's push sends a magnitude because
  // `/v1/payments` applies the sign itself; this one must not.
  const pago = body.ledger.find((e) => e.kind === "pago")!;
  assert.ok(pago.amountCents < 0, "a pago goes up negative, as it is stored");
  const devengo = body.ledger.find((e) => e.kind === "devengo")!;
  assert.ok(devengo.amountCents > 0);

  // Instants are RFC3339 and days are days, which is what the Go types parse.
  assert.match(body.workRecords[0]!.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.ledger[0]!.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.deviceId, phone.repo.sync.identity().deviceId);
});

test("una fecha que no es una fecha se detecta aquí, no en un 400 tras subir la temporada", () => {
  const phone = aPhone(50);
  // `occurredAt` is the one timestamp the contract does NOT allow to be null.
  phone.db.exec("UPDATE pickups SET date = 'ayer', createdAt = 'ayer' WHERE id = 3");
  const x = phone.repo.sync.seasonExport("x", "2026-08-29T12:00:00.000Z");
  assert.ok(verifySeasonExport(x).some((p) => p.includes("no es una fecha")));
});

test("un createdAt ilegible se manda como nulo en vez de tumbar la temporada", () => {
  const phone = aPhone(50);
  phone.db.exec("UPDATE people SET createdAt = 'hace tiempo' WHERE id = 1");
  const input = toImportInput(
    phone.repo.sync.seasonExport("x", "2026-08-29T12:00:00.000Z"),
  );
  const worker = input.workers.find((w) => w.createdAt === null);
  assert.ok(worker, "the unreadable date became a null, and every field is nullable but one");
  // And the rest of the season is untouched by it.
  assert.ok(input.workers.every((w) => w.id));
});

// ---- A real season ------------------------------------------------------

test("una temporada de 18.000 pesadas se empaqueta y se sube en un tiempo humano", async () => {
  const phone = aPhone(18000);
  const before = fingerprint(phone.db);

  const t0 = performance.now();
  const x = phone.repo.sync.seasonExport(identityOf(phone.repo), "2026-08-29T12:00:00.000Z");
  const buildMs = performance.now() - t0;

  const t1 = performance.now();
  const problems = verifySeasonExport(x);
  const checkMs = performance.now() - t1;
  assert.deepEqual(problems, []);

  const t2 = performance.now();
  const body = toImportInput(x);
  const json = JSON.stringify(body);
  const serialiseMs = performance.now() - t2;

  const server = new FakeImportServer();
  const t3 = performance.now();
  const outcome = await importerFor(phone, server).run();
  const uploadMs = performance.now() - t3;

  assert.equal(outcome.status, "imported", outcome.error?.message ?? "");
  assert.equal(server.of("workRecords").length, 18000);
  assert.equal(outcome.report!.balancesChecked, x.reconciliation.balances.length);
  assert.equal(fingerprint(phone.db), before, "18.000 pesadas y el teléfono intacto");

  console.log(
    `      temporada: ${x.totals.workRecords} pesadas, ${x.totals.ledgerEntries} movimientos, ` +
      `${x.totals.settlementItems} líneas, ${outcome.rows} filas · ` +
      `empaquetar ${buildMs.toFixed(0)} ms · verificar ${checkMs.toFixed(0)} ms · ` +
      `serializar ${serialiseMs.toFixed(0)} ms · ${(json.length / 1e6).toFixed(1)} MB · ` +
      `todo el envío ${uploadMs.toFixed(0)} ms`,
  );

  // Generous, because a loaded CI box is not a phone: these are here to catch
  // a regression into a per-row round trip, not to measure hardware. §8 fase 4
  // allows an hour for the whole cut, of which this is one step.
  assert.ok(buildMs < 20000, `empaquetar tardó ${buildMs.toFixed(0)} ms`);
  assert.ok(checkMs < 20000, `verificar tardó ${checkMs.toFixed(0)} ms`);
  // The body has to fit the server's 64 MB cap with room to spare.
  assert.ok(json.length < 32e6, `el cuerpo pesa ${(json.length / 1e6).toFixed(1)} MB`);
});

// ---- El plazo, y una pantalla que no se queda muda -----------------------
//
// §8 fase 4 gives the mudanza an hour, with the owner watching. Two things
// used to make that hour unsurvivable and neither was about the server: the
// request had 25 seconds to move 11,7 MB, and the screen said nothing at all
// while it tried.

test("el plazo de la temporada aguanta 12 MB por un enlace de finca", () => {
  // The arithmetic in `SEASON_IMPORT_TIMEOUT_MS`, pinned so the constant stays
  // a decision with a reason instead of a number somebody rounds down.
  //
  // The name of this test said 12 MB and the number below said 11,7 — and at
  // fifteen minutes the two answers differed: 11,7 MB passed with a margin of
  // exactly zero seconds and 12 MB would have failed. A deadline equal to the
  // upload is not a deadline that covers it; the first link 1 % slower than
  // the assumption aborts the mudanza. So the test now asks what its title
  // always claimed, against a season that is still growing.
  const SEASON_BYTES = 12e6;
  // ~100 kbit/s of usable uplink. What a farm's link degrades to on a bad
  // afternoon, which is the one this has to survive.
  const BAD_LINK_BYTES_PER_S = 13_000;
  const needed = (SEASON_BYTES / BAD_LINK_BYTES_PER_S) * 1000;

  assert.ok(
    SEASON_IMPORT_TIMEOUT_MS >= needed,
    `${(SEASON_IMPORT_TIMEOUT_MS / 60000).toFixed(0)} min no alcanzan para 12 MB ` +
      `a 13 kB/s (hacen falta ${(needed / 60000).toFixed(1)} min)`,
  );
  // And with room, not on the nose. The season measured 11,7 MB mid-harvest
  // and grows every day until the cut; 13 kB/s is a guess at a bad afternoon,
  // not a measured floor. A deadline with no margin against either of those
  // is a deadline that will be met by the farm, once, on the day it matters.
  assert.ok(
    SEASON_IMPORT_TIMEOUT_MS >= needed * 1.5,
    `sin margen: ${(SEASON_IMPORT_TIMEOUT_MS / 60000).toFixed(0)} min contra ` +
      `${(needed / 60000).toFixed(1)} min necesarios`,
  );
  // And it is still a deadline. A socket with no end is a screen that says
  // "enviando" until somebody force-quits the app.
  assert.ok(SEASON_IMPORT_TIMEOUT_MS <= 30 * 60 * 1000);
  // The default is what a sync batch needs and is not what this needs.
  assert.ok(SEASON_IMPORT_TIMEOUT_MS > DEFAULT_TIMEOUT_MS * 20);
});

test("una petición puede llevar su propio plazo, más largo que el del cliente", async () => {
  // The plumbing under the constant: without a per-request deadline the only
  // way to give the import fifteen minutes is to give every weighing push
  // fifteen minutes too, which is how a hung socket holds the outbox all day.
  const http = new HttpClient({
    baseUrl: "https://api.example",
    session: fixedSession(),
    fetchImpl: answersAfter(120, () => new Response("{}", { status: 200 })),
    timeoutMs: 20,
  });

  await assert.rejects(
    () => http.request("/v1/anything"),
    (e: ApiError) => e.code === "TIMEOUT",
    "el plazo del cliente sigue mandando cuando la petición no pide otro",
  );

  // The same client, the same slow answer, one request that asked for room.
  await http.request("/v1/import/season", { method: "POST", timeoutMs: 5000 });
});

test("la subida de la temporada no se aborta con el plazo de un lote de sync", async () => {
  // End to end through the real `RestTransport`, against a client whose
  // default deadline is far too short. If `importSeason` did not ask for its
  // own, this would come back TIMEOUT — which is exactly what the farm saw.
  let seen: SeasonImportInput | null = null;
  const transport = new RestTransport({
    http: new HttpClient({
      baseUrl: "https://api.example",
      session: fixedSession(),
      fetchImpl: answersAfter(120, (init) => {
        seen = JSON.parse(String(init?.body ?? "null"));
        return new Response(JSON.stringify(emptyReport()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
      timeoutMs: 20,
    }),
  });

  const report = await transport.importSeason(anInput());
  assert.equal(report.balancesChecked, 0);
  assert.ok(seen, "el cuerpo salió");
});

test("el tamaño que enseña la pantalla es el que tiene que subir, en bytes", () => {
  // Names on a farm are full of ñ and í: one JS character, two bytes. A size
  // measured in characters understates the climb, and the size is the whole
  // explanation of why the wait is minutes.
  const plain = anInput();
  const accented = anInput();
  accented.workers = [
    {
      id: "0192e6aa-0000-7000-8000-000000000001",
      name: "Ñañez",
      lastName: null,
      documentType: null,
      docId: null,
      tag: null,
      createdAt: null,
      deletedAt: null,
    },
  ];
  const grew = byteLengthOf(accented) - byteLengthOf(plain);
  const chars = JSON.stringify(accented).length - JSON.stringify(plain).length;
  assert.ok(grew > chars, "los dos caracteres con tilde cuentan dos bytes cada uno");
  assert.equal(byteLengthOf(plain), Buffer.byteLength(JSON.stringify(plain), "utf8"));
  assert.equal(byteLengthOf(accented), Buffer.byteLength(JSON.stringify(accented), "utf8"));
});

test("la pantalla recibe fase, filas, bytes y un reloj mientras espera", async () => {
  const phone = aPhone(400);
  const server = new FakeImportServer();
  const seen: SeasonImportProgress[] = [];

  const outcome = await importerFor(phone, server).run({
    onProgress: (p) => seen.push({ ...p }),
  });
  assert.equal(outcome.status, "imported", outcome.error?.message ?? "");

  assert.deepEqual(
    seen.map((p) => p.phase),
    ["building", "checking", "sending"],
  );

  const sending = seen[seen.length - 1];
  assert.equal(sending.rows, outcome.rows);
  assert.ok(sending.rows > 0);
  // The megabytes, which are the reason the wait is what it is. Without them
  // the card is a spinner with a noun on it.
  assert.ok(sending.bytes > 0, "la pantalla no puede decir cuánto pesa");
  assert.equal(sending.bytes, outcome.bytes);
  assert.equal(sending.bytes, byteLengthOf(toImportInput(phone.repo.sync.seasonExport(
    identityOf(phone.repo),
    "2026-08-29T12:00:00.000Z",
  ))));
  // The clock is anchored to the start of the request that carries the
  // deadline, not to the tap: building and checking are their own minutes.
  assert.ok(sending.since >= seen[0].since);
  assert.ok(sending.since <= Date.now());
});

test("una importación que se cae por plazo sigue sin haber tocado el teléfono", async () => {
  // The sentence the screen shows in green while it waits — «si esto falla no
  // se perdió nada» — has to be true of the timeout too, which is the failure
  // a fifteen-minute deadline makes MORE likely to be the one that happens.
  const phone = aPhone(300);
  const before = fingerprint(phone.db);
  const owedBefore = phone.repo.sync.pendingCount();

  const server = new FakeImportServer({
    dieBeforeWriting: { code: "TIMEOUT", message: "la petición tardó demasiado" },
  });
  const outcome = await importerFor(phone, server).run();

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error?.code, "TIMEOUT");
  assert.equal(seasonWasImported(outcome), false);
  assert.equal(server.rows.size, 0);
  assert.equal(fingerprint(phone.db), before, "el teléfono sigue exactamente igual");
  assert.equal(phone.repo.sync.pendingCount(), owedBefore);
  // And the size is on the record, so the retry knows what it is up against.
  assert.ok(outcome.bytes > 0);
});
