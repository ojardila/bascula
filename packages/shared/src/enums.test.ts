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
import { PAYMENTS_SCHEMA } from "../../../apps/mobile/src/schema.ts";

// The enums are worth nothing unless they match what the database enforces.
// These read the value lists straight out of the phone's CHECK constraints, so
// adding a kind in one place and not the other fails here rather than in a
// finca at the end of a week.

/** Pulls 'a','b','c' out of `... IN ('a','b','c')` following a column name. */
function checkedValues(sql: string, column: string): string[] {
  const m = new RegExp(`${column}[\\s\\S]*?IN\\s*\\(([^)]*)\\)`).exec(sql);
  assert.ok(m, `no CHECK ... IN (...) found for ${column}`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

test("LedgerKind is exactly what the ledger CHECK admits", () => {
  assert.deepEqual(checkedValues(PAYMENTS_SCHEMA, "kind"), [...LEDGER_KINDS]);
});

test("SettlementStatus is exactly what the settlements CHECK admits", () => {
  assert.deepEqual(
    checkedValues(PAYMENTS_SCHEMA, "status"),
    [...SETTLEMENT_STATUSES],
  );
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
