/**
 * The golden-case walker.
 *
 * It replays a fixture against the phone's REAL SQL — `BASE_SCHEMA`,
 * `PAYMENTS_SCHEMA`, `PENDING_SQL`, `BALANCE_SQL`, `WEEK_OF`, `DAY_OF`, all
 * imported from `apps/mobile/src/schema.ts` — under `node:sqlite`, exactly the
 * way the existing suites do. Nothing about the balance, the week derivation
 * or the anti double-count lock is retyped here: if it were, the fixtures
 * would only prove that this file agrees with itself.
 *
 * What IS retyped is the *sequence of writes* a settlement performs, because
 * `apps/mobile/src/db.ts` opens `expo-sqlite` at module scope and cannot be
 * imported outside a phone (`docs/diagramas/movil.md` §9.2). The sequence
 * below mirrors `Payments.settle`, `pay`, `advance`, `deduct`, `adjust`,
 * `reverse` and `voidSettlement` statement for statement; the same limitation
 * is why those functions have no tests of their own today.
 *
 * The Go side reads the same JSON files and must produce the same numbers. See
 * ./README.md for the format.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_SCHEMA,
  PAYMENTS_SCHEMA,
  PENDING_SQL,
  BALANCE_SQL,
  DAY_OF,
  WEEK_OF,
} from "../../../apps/mobile/src/schema.ts";
import { amountCents, toCents, fromCents } from "../src/money.ts";
import type { LedgerKind, PayMethod, SettlementStatus } from "../src/enums.ts";

// ---- The fixture format -------------------------------------------------

export interface GoldenPerson {
  id: number;
  name: string;
  lastName: string;
}

export interface GoldenCrop {
  id: number;
  name: string;
}

export type GoldenEvent =
  /** A weighing. `at` is LOCAL wall-clock time in the farm's timezone. */
  | {
      op: "pickup";
      id: number;
      personId: number;
      cropId: number;
      quantity: number;
      at: string;
    }
  /** Freeze every unclaimed pickup up to `to` into a settlement. */
  | { op: "settle"; personId: number; from: string; to: string; on: string; note?: string }
  | { op: "pay"; personId: number; amountCents: number; on: string; method?: PayMethod }
  | { op: "advance"; personId: number; amountCents: number; on: string; note?: string }
  | { op: "deduct"; personId: number; amountCents: number; on: string; note: string }
  | { op: "adjust"; personId: number; signedCents: number; on: string; note: string }
  | { op: "void"; settlementId: number; on: string; note?: string }
  | { op: "reverse"; ledgerId: number; on: string; note: string }
  /**
   * Writes nothing. Records every worker's balance at this point in the story,
   * so a case can pin the middle and not only the end — an advance being eaten
   * week by week is invisible if you only look at the last line.
   */
  | { op: "checkpoint"; label: string };

export interface ExpectedPickup {
  id: number;
  localDay: string;
  week: string;
}

export interface ExpectedItem {
  pickupId: number;
  week: string;
  quantity: number;
  costPerUnitCents: number;
  amountCents: number;
  voided: boolean;
}

export interface ExpectedSettlement {
  id: number;
  personId: number;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  status: SettlementStatus;
  items: ExpectedItem[];
}

export interface ExpectedLedgerRow {
  id: number;
  personId: number;
  kind: LedgerKind;
  amountCents: number;
  date: string;
  settlementId: number | null;
  reversesId: number | null;
}

export interface ExpectedBalance {
  personId: number;
  earnedCents: number;
  paidCents: number;
  deductedCents: number;
  balanceCents: number;
  lastMovementAt: string | null;
}

export interface ExpectedCheckpoint {
  label: string;
  balances: ExpectedBalance[];
}

export interface GoldenExpectation {
  pickups?: ExpectedPickup[];
  settlements?: ExpectedSettlement[];
  ledger?: ExpectedLedgerRow[];
  balances?: ExpectedBalance[];
  checkpoints?: ExpectedCheckpoint[];
}

export interface GoldenCase {
  id: string;
  title: string;
  why: string;
  timezone: string;
  generalRateCents: number;
  weeklyRateCents?: Record<string, number>;
  people: GoldenPerson[];
  crops: GoldenCrop[];
  events: GoldenEvent[];
  expect: GoldenExpectation;
}

// ---- Loading ------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(HERE, "cases");

/** Every case, in filename order, so the suite reports them the same way twice. */
export function loadCases(dir = CASES_DIR): GoldenCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GoldenCase);
}

// ---- Replay -------------------------------------------------------------

/**
 * A local wall-clock stamp -> the UTC instant the phone would store.
 *
 * Built from parts rather than parsed, so this is the same statement in every
 * timezone the suite runs in: "19:30 on Sunday the 30th, wherever you are".
 * SQLite's `'localtime'` converts it back with the same offset, which is
 * precisely the round trip the Sunday-evening case exists to pin.
 */
export function instantOf(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw new Error(`not a local wall-clock stamp: ${local}`);
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +(s ?? "0")).toISOString();
}

interface Ctx {
  db: DatabaseSync;
  generalPesos: number;
  people: number[];
  checkpoints: ExpectedCheckpoint[];
}

/** One worker's position, straight out of the app's own BALANCE_SQL. */
function balanceOf(ctx: Ctx, personId: number): ExpectedBalance {
  const r = ctx.db.prepare(BALANCE_SQL).get(personId, personId) as unknown as ExpectedBalance;
  return {
    personId: r.personId,
    earnedCents: r.earnedCents,
    paidCents: r.paidCents,
    deductedCents: r.deductedCents,
    balanceCents: r.balanceCents,
    lastMovementAt: r.lastMovementAt,
  };
}

/** `costForWeek` from db.ts: the weekly override if there is one, else the general cost. */
function rateCentsFor(ctx: Ctx, week: string): number {
  const o = ctx.db
    .prepare("SELECT costPerUnit FROM cost_overrides WHERE week = ?")
    .get(week) as { costPerUnit: number } | undefined;
  return toCents(o ? o.costPerUnit : ctx.generalPesos);
}

function addEntry(
  ctx: Ctx,
  e: {
    personId: number;
    kind: LedgerKind;
    amountCents: number;
    date: string;
    settlementId?: number | null;
    method?: PayMethod | null;
    note?: string | null;
    reversesId?: number | null;
  },
): number {
  const r = ctx.db
    .prepare(
      `INSERT INTO ledger (personId,kind,amountCents,date,settlementId,method,note,reversesId,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      e.personId,
      e.kind,
      e.amountCents,
      e.date,
      e.settlementId ?? null,
      e.method ?? null,
      e.note ?? null,
      e.reversesId ?? null,
      `${e.date}T12:00:00.000Z`,
    );
  return Number(r.lastInsertRowid);
}

/** `pendingItems` from db.ts, on top of the real PENDING_SQL. */
function pendingItems(ctx: Ctx, personId: number, from: string, to: string) {
  const rows = ctx.db.prepare(PENDING_SQL).all(personId, from, to) as {
    id: number;
    weight: number;
    week: string;
  }[];
  const priceOf = new Map<string, number>();
  return rows.map((r) => {
    if (!priceOf.has(r.week)) priceOf.set(r.week, rateCentsFor(ctx, r.week));
    const costPerUnitCents = priceOf.get(r.week)!;
    return {
      pickupId: r.id,
      week: r.week,
      weight: r.weight,
      costPerUnitCents,
      // Rounded per line, so the printed receipt adds up exactly.
      amountCents: amountCents(r.weight, costPerUnitCents),
    };
  });
}

function settle(ctx: Ctx, ev: Extract<GoldenEvent, { op: "settle" }>): void {
  const items = pendingItems(ctx, ev.personId, ev.from, ev.to);
  const grossCents = items.reduce((s, i) => s + i.amountCents, 0);
  // Nothing pending, or a zero gross: no document is created at all. A $0
  // devengo would violate the ledger CHECK and take the payroll down.
  if (!items.length || grossCents <= 0) return;

  // The period is what the items cover, not the open-ended search range, and
  // the earning is never dated in the future when paying mid-week.
  const periodStart = items.map((i) => i.week).sort()[0] ?? ev.from;
  const postedAt = ev.to > ev.on ? ev.on : ev.to;

  ctx.db.exec("BEGIN");
  const s = ctx.db
    .prepare(
      `INSERT INTO settlements (personId,periodStart,periodEnd,grossCents,status,note,createdAt)
       VALUES (?,?,?,?, 'open', ?, ?)`,
    )
    .run(ev.personId, periodStart, ev.to, grossCents, ev.note ?? null, `${ev.on}T12:00:00.000Z`);
  const settlementId = Number(s.lastInsertRowid);
  for (const i of items) {
    ctx.db
      .prepare(
        `INSERT INTO settlement_items (settlementId,pickupId,week,weight,costPerUnitCents,amountCents)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(settlementId, i.pickupId, i.week, i.weight, i.costPerUnitCents, i.amountCents);
  }
  addEntry(ctx, {
    personId: ev.personId,
    kind: "devengo",
    amountCents: grossCents,
    date: postedAt,
    settlementId,
    note: ev.note ?? null,
  });
  ctx.db.exec("COMMIT");
}

function voidSettlement(ctx: Ctx, ev: Extract<GoldenEvent, { op: "void" }>): void {
  const s = ctx.db
    .prepare("SELECT * FROM settlements WHERE id = ?")
    .get(ev.settlementId) as { personId: number; status: string } | undefined;
  if (!s || s.status === "void") return; // undoing twice changes nothing
  const at = `${ev.on}T12:00:00.000Z`;
  ctx.db.exec("BEGIN");
  // The lines stay for the record; clearing voidedAt is what releases the
  // pickup back to pending, through the partial unique index.
  ctx.db
    .prepare("UPDATE settlement_items SET voidedAt = ? WHERE settlementId = ?")
    .run(at, ev.settlementId);
  ctx.db
    .prepare("UPDATE settlements SET status = 'void', voidedAt = ? WHERE id = ?")
    .run(at, ev.settlementId);
  const devengo = ctx.db
    .prepare("SELECT id, amountCents FROM ledger WHERE settlementId = ? AND kind = 'devengo'")
    .get(ev.settlementId) as { id: number; amountCents: number } | undefined;
  if (devengo) {
    addEntry(ctx, {
      personId: s.personId,
      kind: "reverso",
      amountCents: -devengo.amountCents,
      date: ev.on,
      settlementId: ev.settlementId,
      note: ev.note ?? null,
      reversesId: devengo.id,
    });
  }
  ctx.db.exec("COMMIT");
}

function reverse(ctx: Ctx, ev: Extract<GoldenEvent, { op: "reverse" }>): void {
  const e = ctx.db.prepare("SELECT * FROM ledger WHERE id = ?").get(ev.ledgerId) as
    | { personId: number; amountCents: number; settlementId: number | null }
    | undefined;
  if (!e) throw new Error(`golden: no ledger entry ${ev.ledgerId} to reverse`);
  if (ctx.db.prepare("SELECT id FROM ledger WHERE reversesId = ?").get(ev.ledgerId)) return;
  addEntry(ctx, {
    personId: e.personId,
    kind: "reverso",
    amountCents: -e.amountCents,
    date: ev.on,
    settlementId: e.settlementId,
    note: ev.note,
    reversesId: ev.ledgerId,
  });
}

function requirePositive(cents: number) {
  if (!Number.isFinite(cents) || cents <= 0)
    throw new Error("El monto debe ser mayor que cero");
}

function apply(ctx: Ctx, ev: GoldenEvent): void {
  switch (ev.op) {
    case "pickup":
      ctx.db
        .prepare(
          "INSERT INTO pickups (id,personId,cropId,weight,date,createdAt) VALUES (?,?,?,?,?,?)",
        )
        .run(ev.id, ev.personId, ev.cropId, ev.quantity, instantOf(ev.at), instantOf(ev.at));
      return;
    case "settle":
      return settle(ctx, ev);
    case "pay":
      requirePositive(ev.amountCents);
      addEntry(ctx, {
        personId: ev.personId,
        kind: "pago",
        amountCents: -ev.amountCents,
        date: ev.on,
        method: ev.method ?? "efectivo",
      });
      return;
    case "advance":
      requirePositive(ev.amountCents);
      addEntry(ctx, {
        personId: ev.personId,
        kind: "anticipo",
        amountCents: -ev.amountCents,
        date: ev.on,
        method: "efectivo",
        note: ev.note ?? null,
      });
      return;
    case "deduct":
      requirePositive(ev.amountCents);
      addEntry(ctx, {
        personId: ev.personId,
        kind: "deduccion",
        amountCents: -ev.amountCents,
        date: ev.on,
        note: ev.note,
      });
      return;
    case "adjust":
      if (!Number.isFinite(ev.signedCents) || ev.signedCents === 0)
        throw new Error("El ajuste no puede ser cero");
      addEntry(ctx, {
        personId: ev.personId,
        kind: "ajuste",
        amountCents: Math.round(ev.signedCents),
        date: ev.on,
        note: ev.note,
      });
      return;
    case "void":
      return voidSettlement(ctx, ev);
    case "reverse":
      return reverse(ctx, ev);
    case "checkpoint":
      ctx.checkpoints.push({
        label: ev.label,
        balances: ctx.people.map((id) => balanceOf(ctx, id)),
      });
      return;
  }
}

// ---- Observation --------------------------------------------------------

const PICKUP_WEEKS_SQL = `SELECT id, ${DAY_OF("date")} AS localDay, ${WEEK_OF("date")} AS week
                            FROM pickups ORDER BY id`;

/**
 * Replays a case and reports what the database ended up holding, in exactly the
 * shape of `case.expect`. Only the keys the case actually declares are filled
 * in, so a fixture asserts what it says and nothing more.
 */
export function runCase(c: GoldenCase): GoldenExpectation {
  const db = new DatabaseSync(":memory:");
  // WAL is meaningless for an in-memory database and SQLite refuses it there.
  db.exec(BASE_SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  db.exec(PAYMENTS_SCHEMA);

  for (const p of c.people)
    db.prepare("INSERT INTO people (id,name,lastName) VALUES (?,?,?)").run(
      p.id,
      p.name,
      p.lastName,
    );
  for (const cr of c.crops)
    db.prepare("INSERT INTO crops (id,name) VALUES (?,?)").run(cr.id, cr.name);

  // Rates travel through the fixture in integer cents; the phone's `config`
  // and `cost_overrides` hold pesos, and `toCents` puts them back.
  const generalPesos = fromCents(c.generalRateCents);
  db.prepare("INSERT INTO config (id, costPerUnit) VALUES (1, ?)").run(generalPesos);
  for (const [week, cents] of Object.entries(c.weeklyRateCents ?? {}))
    db.prepare("INSERT INTO cost_overrides (week, costPerUnit) VALUES (?, ?)").run(
      week,
      fromCents(cents),
    );

  const ctx: Ctx = {
    db,
    generalPesos,
    people: c.people.map((p) => p.id),
    checkpoints: [],
  };
  for (const ev of c.events) apply(ctx, ev);

  const actual: GoldenExpectation = {};

  // node:sqlite hands back null-prototype rows; spreading them into plain
  // objects is what lets deepStrictEqual compare them against parsed JSON.
  if (c.expect.pickups) {
    actual.pickups = (db.prepare(PICKUP_WEEKS_SQL).all() as unknown as ExpectedPickup[]).map(
      (r) => ({ ...r }),
    );
  }

  if (c.expect.settlements) {
    const rows = db
      .prepare(
        `SELECT id, personId, periodStart, periodEnd, grossCents, status
           FROM settlements ORDER BY id`,
      )
      .all() as unknown as Omit<ExpectedSettlement, "items">[];
    actual.settlements = rows.map((s) => ({
      ...s,
      items: (
        db
          .prepare(
            `SELECT pickupId, week, weight AS quantity, costPerUnitCents, amountCents, voidedAt
               FROM settlement_items WHERE settlementId = ? ORDER BY id`,
          )
          .all(s.id) as unknown as (Omit<ExpectedItem, "voided"> & { voidedAt: string | null })[]
      ).map(({ voidedAt, ...i }) => ({ ...i, voided: voidedAt !== null })),
    }));
  }

  if (c.expect.ledger) {
    actual.ledger = (
      db
        .prepare(
          `SELECT id, personId, kind, amountCents, date, settlementId, reversesId
             FROM ledger ORDER BY id`,
        )
        .all() as unknown as ExpectedLedgerRow[]
    ).map((r) => ({ ...r }));
  }

  if (c.expect.balances) {
    actual.balances = c.expect.balances.map((b) => balanceOf(ctx, b.personId));
  }

  if (c.expect.checkpoints) actual.checkpoints = ctx.checkpoints;

  db.close();
  return actual;
}
