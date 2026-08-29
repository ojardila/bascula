import { test } from "node:test";
import assert from "node:assert/strict";
import { csvField, csvRow, csvDocument } from "./csv.ts";

test("plain values are left alone", () => {
  assert.equal(csvField("Ana"), "Ana");
  assert.equal(csvField(47.5), "47.5");
});

test("a comma in a name does not become a new column", () => {
  // "Muñoz, Carlos" is exactly how a document field gets typed.
  assert.equal(csvField("Muñoz, Carlos"), '"Muñoz, Carlos"');
});

test("quotes inside a value are doubled, not dropped", () => {
  assert.equal(csvField('lote "el alto"'), '"lote ""el alto"""');
});

test("a line break inside a note stays inside its field", () => {
  assert.equal(csvField("pago\nparcial"), '"pago\nparcial"');
});

test("empty and missing values are empty fields", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");
  assert.equal(csvField(""), "");
});

test("a row joins fields with commas", () => {
  assert.equal(csvRow(["Ana", 50, "Café lote 1"]), "Ana,50,Café lote 1");
});

test("a document carries the BOM so accents survive in a spreadsheet", () => {
  const doc = csvDocument(["nombre"], [["María"]]);
  assert.ok(doc.startsWith("﻿"), "without it Excel mangles the accents");
  assert.ok(doc.includes("María"));
});

test("rows are separated the way spreadsheets expect", () => {
  const doc = csvDocument(["a", "b"], [[1, 2], [3, 4]]);
  assert.equal(doc, "﻿a,b\r\n1,2\r\n3,4\r\n");
});

// --- What actually leaves the phone ---------------------------------------

import { DatabaseSync } from "node:sqlite";
import {
  BASE_SCHEMA,
  PAYMENTS_SCHEMA,
  EXPORT_PICKUPS_SQL,
  EXPORT_LEDGER_SQL,
  EXPORT_BALANCES_SQL,
} from "./schema.ts";
import {
  dayInZone,
  weekInZone,
} from "../../../packages/shared/src/time.ts";

function seeded() {
  const db = new DatabaseSync(":memory:");
  db.exec(BASE_SCHEMA.replace("PRAGMA journal_mode = WAL;", ""));
  db.exec(PAYMENTS_SCHEMA);
  // A name with a comma in it, which is exactly what breaks a naive CSV.
  db.prepare("INSERT INTO people (id,name,lastName,docId) VALUES (1,'Carlos','Muñoz, Jr','CC123')").run();
  db.prepare("INSERT INTO crops (id,name,dimension) VALUES (1,'Café lote 1',2.5)").run();
  db.prepare(
    `INSERT INTO pickups (personId,cropId,weight,date,localDay,week)
     VALUES (1,1,52.5,'2026-08-25T14:00:00Z',?,?)`,
  ).run(dayInZone("2026-08-25T14:00:00Z"), weekInZone("2026-08-25T14:00:00Z"));
  db.prepare(
    `INSERT INTO ledger (personId,kind,amountCents,date,method,note,createdAt)
     VALUES (1,'pago',-4000000,'2026-08-27','efectivo','abono, parcial','x')`,
  ).run();
  return db;
}

test("the exported pickups carry the week and the local day", () => {
  const rows = seeded().prepare(EXPORT_PICKUPS_SQL).all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].semana, "2026-08-24");
  assert.equal(rows[0].lote, "Café lote 1");
  assert.equal(rows[0].peso, 52.5);
});

test("money is exported in pesos, not in cents", () => {
  const rows = seeded().prepare(EXPORT_LEDGER_SQL).all() as Record<string, unknown>[];
  assert.equal(rows[0].monto, -40000, "a spreadsheet should not have to divide by 100");
});

test("balances come out per worker", () => {
  const rows = seeded().prepare(EXPORT_BALANCES_SQL).all() as Record<string, unknown>[];
  assert.equal(rows[0].saldo, -40000);
});

test("a name with a comma survives the round trip", () => {
  const rows = seeded().prepare(EXPORT_PICKUPS_SQL).all() as Record<string, unknown>[];
  const header = Object.keys(rows[0]);
  const doc = csvDocument(header, rows.map((r) => header.map((h) => r[h])));
  const line = doc.split("\r\n")[1];
  assert.ok(line.includes('"Carlos Muñoz, Jr"'), "quoted, so it stays one column");
  assert.equal(line.split(",").length, header.length + 1, "the quoted comma adds one split");
});
