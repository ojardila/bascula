/**
 * The app with `LOCAL_SETTLEMENT` off, walked end to end.
 *
 * This is the test the preparation exists for. `flags.ts` promises that
 * flipping one constant leaves an app that is still coherent and still useful,
 * and a promise about a build nobody has ever run is worth nothing. The day
 * somebody flips it will be a day they are in a hurry, so the checking happens
 * now, with the flag still on and the farm still paying from the handset.
 *
 * It is in two halves, because "no path is broken" is two different claims:
 *
 *   1. **Structural.** Every call that settles or pays sits behind the flag,
 *      no control that would call one survives it, and every sentence the
 *      flag-off build shows exists in all three dictionaries. These are read
 *      off the screens' source, which is the only way to assert something
 *      about a compile-time constant without shipping two builds — and it is
 *      not a weaker check than rendering: it catches the fifth screen somebody
 *      adds next sprint, which a render test of four screens never would.
 *
 *   2. **Behavioural.** What `simplificacion.md` §2.1 says the farm keeps —
 *      weigh, read the balance, hand over an advance, print its voucher — done
 *      for real against the real repository over `node:sqlite`, using only the
 *      methods a flag-off build can reach. If this half passes, a phone with
 *      the flag off is still worth carrying into a lote.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { nodeSqlite } from "./data/nodeSqlite.ts";
import { createSqliteRepository } from "./data/sqliteRepository.ts";
import type { Repository } from "./data/repository.ts";
import { LOCAL_SETTLEMENT } from "./flags.ts";
import { balanceDisplay } from "./balanceDisplay.ts";
import { advanceReceiptHtml } from "./receiptHtml.ts";
import { translate } from "./strings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");

// ---- 1. Structural ------------------------------------------------------

/**
 * The methods that settle or pay. Every one of them writes a `devengo` or a
 * `pago`, which are exactly the two things the server refuses from a handset
 * and the two that move to the console.
 */
const MONEY_MOVERS = [
  "settle",
  "runPayroll",
  "undoRun",
  "voidSettlement",
  "pay",
] as const;

/** Every screen that can reach one of them. */
const MONEY_SCREENS = [
  "screens/PayWorker.tsx",
  "screens/PaymentsPanel.tsx",
  "screens/Account.tsx",
];

test("the flag ships ON, because the farm settles from this handset today", () => {
  // The point of the sprint, pinned. Nothing is removed while the console
  // cannot pay a crew (`simplificacion.md` §2.1 and §6): a green suite with
  // this flipped would mean the farm had already lost its Saturday.
  assert.equal(LOCAL_SETTLEMENT, true);
});

test("every screen that settles or pays imports the flag", () => {
  for (const rel of MONEY_SCREENS) {
    const src = read(rel);
    assert.match(
      src,
      /import \{ LOCAL_SETTLEMENT \} from "\.\.\/flags\.ts"/,
      `${rel} moves money and does not know about the flag`,
    );
  }
});

test("no call that settles or pays is reachable without the flag", () => {
  // Read as: each `Payments.<mover>(` in a screen must have `LOCAL_SETTLEMENT`
  // mentioned somewhere in the function or the JSX branch that contains it.
  // Approximated by proximity, which is what makes it a cheap regression
  // rather than a type system: a new unguarded call lands far from any
  // mention of the flag, and that is the shape of the mistake being caught.
  for (const rel of MONEY_SCREENS) {
    const src = read(rel);
    for (const mover of MONEY_MOVERS) {
      const needle = `Payments.${mover}(`;
      let from = 0;
      for (;;) {
        const at = src.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;
        const window = src.slice(Math.max(0, at - 1400), at);
        assert.ok(
          window.includes("LOCAL_SETTLEMENT"),
          `${rel}: ${needle} is not behind the flag`,
        );
      }
    }
  }
});

test("with the flag off nothing is merely disabled — the controls are gone", () => {
  // A permanently greyed-out «Confirmar pago» is a dead button, and a dead
  // button on a money screen reads as a broken app rather than a moved one.
  const payWorker = read("screens/PayWorker.tsx");
  assert.match(
    payWorker,
    /\{LOCAL_SETTLEMENT && \(\s*<Button/,
    "the confirm button is not rendered conditionally on the flag",
  );
  const panel = read("screens/PaymentsPanel.tsx");
  assert.match(
    panel,
    /LOCAL_SETTLEMENT \? \(/,
    "the crew payroll buttons are not rendered conditionally on the flag",
  );
});

test("every screen that loses a button says where the work went", () => {
  // The farm has pressed the same two controls every Saturday for months. A
  // control that vanishes with no sentence in its place teaches nothing and
  // gets reported as a bug.
  assert.match(read("screens/PayWorker.tsx"), /pay\.movedToWebWorker/);
  assert.match(read("screens/PaymentsPanel.tsx"), /pay\.movedToWebCrew/);
  assert.match(read("screens/Account.tsx"), /pay\.movedToWebWorker/);
});

test("the sentences the flag-off build shows exist in all three dictionaries", () => {
  // `translate` falls back to Spanish and then to the raw key, so a missing
  // Portuguese string is not a crash — it is «pay.movedToWebCrew» printed on
  // the screen of somebody who needed the sentence most.
  const keys = [
    "pay.movedToWebTitle",
    "pay.movedToWebWorker",
    "pay.movedToWebCrew",
    "pay.advanceReceipt",
    "pay.advanceDelivered",
    "pay.advanceReceiptNote",
    "pay.balanceUnknownShort",
    "pay.balanceUnknownWhy",
    "pay.balanceUnknownBody",
    "pay.asOf",
    "pay.asOfProvisional",
  ];
  for (const lang of ["es", "en", "pt"] as const)
    for (const key of keys)
      assert.notEqual(translate(lang, key), key, `${key} is missing in ${lang}`);
});

test("handing over an advance does not depend on the flag", () => {
  // The escape hatch of §6.2 and the whole of the "después" column of §2.1.
  // If this ever ends up inside a flag branch, a flag-off phone becomes a
  // notebook of kilos.
  const adjust = read("screens/Adjust.tsx");
  assert.ok(!adjust.includes("LOCAL_SETTLEMENT"), "the advance screen must not be gated");
  assert.match(adjust, /Payments\.advance\(/);
  assert.match(adjust, /printAdvance\(/, "the advance screen must print its voucher");

  // And the gate panel in PayWorker, which is the other place cash is handed
  // over, keeps its advance button outside any flag branch.
  const payWorker = read("screens/PayWorker.tsx");
  assert.match(payWorker, /onPress=\{handOverAdvance\}/);
  assert.match(payWorker, /printAdvance\(/);
});

test("no screen is left an orphan: every route still has a way in", () => {
  // `Adjust` is reached only from `Account`, and `Account` only from screens
  // that survive. If the flag ever took `Account`'s entry points away, the
  // advance screen would exist with no way to open it.
  assert.match(read("screens/Account.tsx"), /navigation\.navigate\("Adjust"/);
  assert.match(read("screens/WorkerDetail.tsx"), /navigation\.navigate\("Account"/);
  // And WorkerDetail is reached from the People list, which no flag touches.
  assert.match(read("screens/People.tsx"), /navigation\.navigate\("WorkerDetail"/);
});

// ---- 2. Behavioural -----------------------------------------------------

let raw: DatabaseSync;
let repo: Repository;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
});

const worker = () =>
  repo.people.add({
    name: "Ana",
    lastName: "Rodríguez",
    documentType: "CC",
    docId: "1000",
    tag: "T1",
    image: "",
  }).lastInsertRowId;

const plot = () =>
  repo.crops.add({ name: "Lote 1", type: "Café", variety: "Castillo", dimension: 2.5 })
    .lastInsertRowId;

test("a flag-off phone can still do the whole of the lote's day", () => {
  const personId = worker();
  const cropId = plot();

  // 1. WEIGH. Untouched by any of this, and the reason the phone exists.
  repo.pickups.add({ personId, cropId, weight: 40, date: new Date().toISOString() });
  repo.pickups.add({ personId, cropId, weight: 35.5, date: new Date().toISOString() });
  assert.equal(repo.reports.totals()?.pickups, 2);

  // 2. READ THE BALANCE. Not derived here any more — read, with its age.
  //    A phone that has never heard one says so rather than showing $0.
  // `registered: true` — this walk is the post-move phone, which is the one
  // the flag will be off on. An unregistered handset is a different state and
  // `balanceDisplay.test.ts` pins it: it shows its own ledger, because before
  // the move this phone IS the book.
  const cold = balanceDisplay(repo.payments.fullBalance(personId), 0, true);
  assert.equal(cold.state, "unknown");
  assert.ok(!("cents" in cold), "the unknown state must carry no number to render");

  repo.sync.recordServerBalances(
    [{ workerId: repo.people.byId(personId)!.uuid!, balanceCents: 34_000_00 }],
    "2026-08-23T12:00:00.000Z",
  );
  // The two weighings above are still in the outbox, so the honest answer is
  // "provisional" — the server's last word does not include them yet. Note
  // what it is NOT: the state is provisional, but the figure is still anchored
  // to a real instant, and the age travels with it.
  const full = repo.payments.fullBalance(personId);
  const warm = balanceDisplay(full, repo.sync.pendingCount(), true);
  assert.equal(warm.state, "provisional");
  assert.ok(warm.state === "provisional");
  assert.equal(warm.at, "2026-08-23T12:00:00.000Z", "a provisional figure still says when");
  assert.ok(warm.pending >= 1, "and how much of this phone the server has not heard");
  // The provisional arithmetic: the server's figure brought forward by what
  // this phone has done since — NOT this phone's own ledger sum, which drops
  // the jornales the server counts and the handset cannot itemise.
  assert.equal(warm.cents, full.itemisedCents + full.notItemisableCents);

  // 3. HAND OVER AN ADVANCE. `advance` is not one of the movers, so this is
  //    reachable with the flag off — which is the whole escape hatch of §6.2.
  const ledgerId = repo.payments.advance(personId, 300_00);
  assert.ok(ledgerId > 0);
  const history = repo.payments.history(personId);
  assert.equal(history[0].kind, "anticipo");
  assert.equal(history[0].amountCents, -300_00, "an advance is stored negative");

  // 4. PRINT ITS VOUCHER, and the voucher carries no balance.
  const html = advanceReceiptHtml(
    {
      workerName: "Ana Rodríguez",
      workerDoc: "CC 1000",
      farmLabel: "La Esperanza",
      amountCents: 300_00,
      date: "2026-08-29",
    },
    "es",
  );
  assert.match(html, /Ana Rodríguez/);
  assert.match(html, /CC 1000/);
  assert.ok(html.includes(translate("es", "pay.advanceDelivered")));
  assert.ok(html.includes(translate("es", "pay.signWorker")));

  // 5. And the movements are readable, so the balance can be disputed.
  assert.ok(repo.payments.history(personId).length >= 1);
});

test("the advance voucher cannot carry a balance, by the shape of its input", () => {
  // Not "we remembered not to pass it": there is no field for it. A balance on
  // this paper would be a figure from the last time the handset heard from the
  // server — days old — printed on a document the worker keeps.
  const personId = worker();
  repo.payments.advance(personId, 180_00);
  const balance = repo.payments.balance(personId).balanceCents;
  assert.equal(balance, -180_00);

  const html = advanceReceiptHtml(
    {
      workerName: "Ana",
      farmLabel: "La Esperanza",
      amountCents: 180_00,
      date: "2026-08-29",
    },
    "es",
  );

  // The magnitude handed over appears. The balance does not, in any form.
  assert.ok(html.includes("180"), "the amount handed over is the point of the paper");
  for (const key of ["pay.balanceTitle", "pay.owesUs", "pay.weOwe", "pay.credit"])
    assert.ok(
      !html.includes(translate("es", key)),
      `the advance voucher must not print ${key}`,
    );
  // And no weighing lines: an advance claims no work.
  assert.ok(!html.includes(translate("es", "reports.week")));
});

test("the source of the advance voucher has no balance field to fill in", () => {
  const src = read("receiptHtml.ts");
  const from = src.indexOf("export interface AdvanceReceiptData");
  const to = src.indexOf("}", from);
  assert.ok(from !== -1, "AdvanceReceiptData is gone");
  const body = src.slice(from, to);
  assert.ok(!body.includes("balanceCents"), "AdvanceReceiptData grew a balance");
  assert.ok(!body.includes("lines"), "AdvanceReceiptData grew weighing lines");
  assert.ok(!body.includes("paidCents"), "AdvanceReceiptData grew a paid figure");
});
