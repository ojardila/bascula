import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_KINDS,
  PAY_METHODS,
  ROLES,
  SETTLEMENT_STATUSES,
  PAY_MODES,
  SEED_ACTIVITY_CATEGORIES,
  isOneOf,
} from "./enums.ts";
import { readFileSync } from "node:fs";

// The enums are worth nothing unless they match what the database enforces.
// These read the value lists straight out of the server's CREATE TYPE ... AS
// ENUM, so adding a kind in one place and not the other fails here rather
// than in a finca at the end of a week.
const ROLES_SQL = readFileSync(
  new URL("../../../services/api/migrations/00001_extensions_and_roles.sql", import.meta.url),
  "utf8",
);

/** Pulls 'a','b','c' out of `CREATE TYPE <name> AS ENUM ('a','b','c')`. */
function enumValues(sql: string, type: string): string[] {
  const m = new RegExp(`CREATE TYPE\\s+${type}\\s+AS ENUM\\s*\\(([^)]*)\\)`).exec(sql);
  assert.ok(m, `no CREATE TYPE ${type} AS ENUM (...) found`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

test("LedgerKind is exactly the ledger_kind enum", () => {
  assert.deepEqual(enumValues(ROLES_SQL, "ledger_kind"), [...LEDGER_KINDS]);
});

test("SettlementStatus is exactly the settlement_status enum", () => {
  assert.deepEqual(enumValues(ROLES_SQL, "settlement_status"), [...SETTLEMENT_STATUSES]);
});

test("PayMethod and Role are exactly their enums", () => {
  assert.deepEqual(enumValues(ROLES_SQL, "pay_method"), [...PAY_METHODS]);
  assert.deepEqual(enumValues(ROLES_SQL, "farm_role"), [...ROLES]);
});

test("the sets are closed, and membership is checked by value", () => {
  assert.ok(isOneOf(LEDGER_KINDS, "anticipo"));
  assert.ok(!isOneOf(LEDGER_KINDS, "Anticipo"));
  assert.ok(!isOneOf(LEDGER_KINDS, "adelanto"));
  assert.ok(isOneOf(PAY_METHODS, "transferencia"));
  assert.ok(isOneOf(ROLES, "weigher"));
  // superadmin is a flag on the user, never a role inside a farm.
  assert.ok(!isOneOf(ROLES, "superadmin"));
  assert.ok(isOneOf(PAY_MODES, "work_unit"));
  assert.ok(!isOneOf(PAY_MODES, "unidad_trabajo"), "the Spanish spelling is the DDL's, not the API's");
  assert.ok(isOneOf(SEED_ACTIVITY_CATEGORIES, "cosecha"));
  assert.ok(!isOneOf(SEED_ACTIVITY_CATEGORIES, undefined));
});

test("no set has a duplicate, which would silently shrink a validator", () => {
  for (const set of [
    LEDGER_KINDS,
    PAY_METHODS,
    ROLES,
    SETTLEMENT_STATUSES,
    PAY_MODES,
    SEED_ACTIVITY_CATEGORIES,
  ]) {
    assert.equal(new Set(set).size, set.length);
  }
});
