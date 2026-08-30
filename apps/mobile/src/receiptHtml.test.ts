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

// ---- What a worker can actually check -----------------------------------

test("a receipt whose lines know their day lists one row per load", () => {
  // The complaint this closes: the breakdown was per WEEK, so somebody who
  // picked six days got one line of «501 kg» and could verify nothing. The
  // file's own comment has said for two sprints that the breakdown is the
  // point of the document.
  const html = receiptHtml(
    {
      ...base,
      lines: [
        { week: "2026-08-24", weight: 85, amountCents: 8_075_00, day: "2026-08-25" },
        { week: "2026-08-24", weight: 70, amountCents: 6_650_00, day: "2026-08-25" },
        { week: "2026-08-24", weight: 92, amountCents: 8_740_00, day: "2026-08-26" },
      ],
    },
    "es",
  );

  assert.ok(html.includes("Día"), "the column is a day, not a week");
  assert.ok(!html.includes("24–30 ago"), "and no week range is printed instead");
  assert.ok(html.includes("26 ago"), "the newest day first");
  assert.ok(html.indexOf("26 ago") < html.indexOf("25 ago"));
  // Each load on its own row: this is the whole point.
  for (const kg of ["85 kg", "70 kg", "92 kg"]) assert.ok(html.includes(kg), kg);
  // And the date is printed once per day. Three rows saying «martes» read as
  // three Tuesdays.
  assert.equal(html.split("25 ago").length - 1, 1, "the repeated day is not repeated");
});

test("a document whose weighings this phone does not hold still prints by week", () => {
  // A settlement that came down the feed can carry lines with no pickup row
  // here. Half a breakdown — some rows dated, some not — would be worse than
  // an honest coarse one, so the whole document falls back together.
  const html = receiptHtml(
    {
      ...base,
      lines: [
        { week: "2026-08-24", weight: 315, amountCents: 29925000, day: "2026-08-25" },
        { week: "2026-08-17", weight: 501, amountCents: 44088000 },
      ],
    },
    "es",
  );
  assert.ok(html.includes("24–30 ago"));
  assert.ok(html.includes("17–23 ago"));
  assert.ok(!html.includes(">Día<"));
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
  // «Anticipo», not «avance». They were the same money under two names and
  // both were printed — so a worker comparing two pieces of paper from the
  // same farm read two different words for the one thing that matters most to
  // them. The advance voucher already said «anticipo», so that is the word the
  // rest of the product moved to rather than the other way round.
  assert.ok(owing.includes("Anticipo pendiente"));
  assert.ok(!owing.includes("Avance"), "one name for one thing, on paper above all");
  assert.ok(owing.includes("-$50.000"), "a debt carries its sign on paper");
});

test("the receipt says what happened, not what a button would have done", () => {
  // `pay.pay` is «Pagar» — an infinitive, correct on a control and wrong on a
  // signed document, where the worker is holding proof that the money already
  // changed hands.
  const html = receiptHtml(base, "es");
  assert.ok(html.includes("Se le entregó"));
  assert.ok(!html.includes(">Pagar<"), "no imperative survives onto the paper");
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

test("a receipt states what the document says, not what the lines add up to", () => {
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
  assert.ok(html.includes("$752.130"), "the total is the document's");
  // And the difference is NAMED rather than folded in, so a worker checking
  // the total against the weeks listed can see why it is bigger.
  assert.ok(html.includes("Otros trabajos"), "and it says where it comes from");
  assert.ok(html.includes("$12.000"), "y cuánto es");
});

test("a receipt with no document to cite still adds up its lines", () => {
  // The ordinary case, and the one that must not change: a settlement written
  // on this phone has a gross equal to its lines, and there is no extra row.
  const html = receiptHtml(base, "es");
  assert.ok(!html.includes("Otros trabajos"));
  const itemised = base.lines.reduce((s, l) => s + l.amountCents, 0);
  assert.equal(itemised, 74_013_000);
  assert.ok(html.includes("$740.130"));
});
