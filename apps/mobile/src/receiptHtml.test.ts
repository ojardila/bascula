import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptHtml, payrollHtml } from "./receiptHtml.ts";

const base = {
  workerName: "María Gómez",
  workerDoc: "CC 1000000",
  farmLabel: "Café",
  unit: "kg",
  lines: [
    { week: "2026-08-24", weight: 315, amountCents: 29925000 },
    { week: "2026-08-17", weight: 501, amountCents: 44088000 },
  ],
  balanceCents: 187554600,
  paidCents: 40000000,
  date: "2026-08-28",
};

test("the receipt lists each week with its weight and value", () => {
  const html = receiptHtml(base, "es");
  assert.ok(html.includes("24–30 ago"));
  assert.ok(html.includes("17–23 ago"));
  assert.ok(html.includes("$299.250"));
  assert.ok(html.includes("$440.880"));
});

test("weeks read newest first, the way the season is remembered", () => {
  const html = receiptHtml(base, "es");
  assert.ok(html.indexOf("24–30 ago") < html.indexOf("17–23 ago"));
});

test("the total is the sum of the lines, not a number typed twice", () => {
  const html = receiptHtml(base, "es");
  assert.ok(html.includes("$740.130"), "299.250 + 440.880");
  assert.ok(html.includes("816 kg"), "315 + 501");
});

test("a credit balance is shown as the worker's, an advance as owed", () => {
  assert.ok(receiptHtml(base, "es").includes("Saldo a favor"));
  const owing = receiptHtml({ ...base, balanceCents: -5000000 }, "es");
  assert.ok(owing.includes("Avance pendiente"));
  assert.ok(owing.includes("-$50.000"), "a debt carries its sign on paper");
});

test("a settled balance of zero prints no balance line at all", () => {
  const html = receiptHtml({ ...base, balanceCents: 0 }, "es");
  assert.ok(!html.includes("Saldo a favor"));
  assert.ok(!html.includes("Avance pendiente"));
});

test("there is somewhere to sign", () => {
  const html = receiptHtml(base, "es");
  assert.ok(html.includes("Firma del recolector"));
  assert.ok(html.includes("Firma de la finca"));
});

test("a name with angle brackets cannot break the document", () => {
  // Names come from a text field, so they are untrusted input.
  const html = receiptHtml({ ...base, workerName: '<script>alert("x")</script>' }, "es");
  assert.ok(!html.includes("<script>"), "escaped, not injected");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the receipt follows the language it is asked for", () => {
  const en = receiptHtml(base, "en");
  assert.ok(en.includes("Payment receipt"));
  assert.ok(en.includes("Aug 24–30"), "and its date format");
  assert.ok(en.includes("$299,250"), "and its thousands separator");
});

test("the payroll sheet totals what was actually handed over", () => {
  const html = payrollHtml(
    [
      { name: "Ana", kg: 100, paidCents: 8000000, balanceCents: 0 },
      { name: "Beto", kg: 50, paidCents: 4000000, balanceCents: 1000000 },
    ],
    { title: "Planilla", farmLabel: "Café", unit: "kg", date: "2026-08-28" },
    "es",
  );
  assert.ok(html.includes("$120.000"), "80.000 + 40.000");
  assert.ok(html.includes("150"), "the kilos too");
});

test("a worker with nothing left over gets a dash, not a zero", () => {
  const html = payrollHtml(
    [{ name: "Ana", kg: 100, paidCents: 8000000, balanceCents: 0 }],
    { title: "Planilla", farmLabel: "Café", unit: "kg", date: "2026-08-28" },
    "es",
  );
  assert.ok(html.includes("—"), "a zero balance would read as an amount");
});

// ---- A settlement this handset cannot fully itemise ---------------------

test("un recibo declara lo que dice el documento, no lo que suman las líneas", () => {
  // The receipt added its own lines up. That is the same figure for a
  // settlement written here, and it is NOT the same figure for one that came
  // down the feed covering a week the worker also spent on a jornal: the
  // header travels whole, the work records behind the jornal lines do not
  // (§2.2), and `applySettlement` drops those lines as orphans.
  //
  // So the worker was handed a signed piece of paper declaring less than they
  // earned, and the paper looked internally consistent.
  const jornalCents = 12_000_00;
  const itemised = base.lines.reduce((s, l) => s + l.amountCents, 0);
  const html = receiptHtml({ ...base, grossCents: itemised + jornalCents }, "es");

  // The lines add up to $740.130; the document says $752.130.
  assert.ok(html.includes("$752.130"), "el total es el del documento");
  // And the difference is NAMED rather than folded in, so a worker checking
  // the total against the weeks listed can see why it is bigger.
  assert.ok(html.includes("Otros trabajos"), "y se dice de dónde sale");
  assert.ok(html.includes("$12.000"), "y cuánto es");
});

test("un recibo sin documento que citar sigue sumando sus líneas", () => {
  // The ordinary case, and the one that must not change: a settlement written
  // on this phone has a gross equal to its lines, and there is no extra row.
  const html = receiptHtml(base, "es");
  assert.ok(!html.includes("Otros trabajos"));
  const itemised = base.lines.reduce((s, l) => s + l.amountCents, 0);
  assert.equal(itemised, 74_013_000);
  assert.ok(html.includes("$740.130"));
});
