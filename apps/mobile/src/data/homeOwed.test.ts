/**
 * A home screen with no card on it is a farm being told there is nobody to pay.
 *
 * `Home` built its «por pagar» card from
 * `Payments.pendingAll(cfg?.costPerUnit ?? 0).filter(r => r.amountCents > 0)`
 * and rendered nothing at all when that came back empty. With no price, every
 * row prices at zero, the filter takes all of them, and the card disappears —
 * on a farm with three workers and 120 kg unsettled on the books.
 *
 * Measured before the fix, three workers at 40 kg each:
 *   price=0:   pendingAll rows=3, after filter=0  → card visible? false
 *   price=800: pendingAll rows=3, after filter=3  → card visible? true
 *
 * The data layer knew. Only the screen threw it away. `docs/auditorias.md`:
 * not knowing is not zero, and here it was not even zero — it was silence.
 *
 * The arithmetic is pinned here, away from the screen, for `balanceDisplay`'s
 * reason: a render test can only assert that some text appeared somewhere.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { nodeSqlite } from "./nodeSqlite.ts";
import { createSqliteRepository } from "./sqliteRepository.ts";
import type { PendingWorker, Repository } from "./repository.ts";

let raw: DatabaseSync;
let repo: Repository;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  repo = createSqliteRepository(nodeSqlite(raw));
  repo.init();
  repo.crops.add({ name: "Lote 1", type: "Café", variety: "Castillo", dimension: 1 });
});

function crew(names: string[]) {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  for (const name of names) {
    const id = repo.people.add({
      name, lastName: "R", documentType: "CC", docId: name, tag: name, image: "",
    }).lastInsertRowId;
    repo.pickups.add({ personId: id, cropId: 1, weight: 40, date: d.toISOString() });
  }
}

/** Exactly what Home computes, so the test moves when the screen does. */
function card(rows: readonly PendingWorker[]) {
  const owed = rows.filter((r) => r.amountCents > 0);
  return {
    people: owed.length,
    cents: owed.reduce((s, r) => s + r.amountCents, 0),
    unpriced: rows.filter((r) => r.amountCents <= 0 && r.kg > 0).length,
  };
}

test("kilos nobody could price are counted, not dropped", () => {
  crew(["Ana", "Beto", "Caro"]);
  const c = card(repo.payments.pendingAll(0));

  assert.equal(c.unpriced, 3, "the unpriced workers are being thrown away again");
  assert.equal(c.people, 0);
  assert.equal(c.cents, 0);
  // The whole point: something is shown.
  assert.ok(c.people > 0 || c.unpriced > 0, "the card would render nothing at all");
});

test("a priced farm is untouched", () => {
  crew(["Ana", "Beto", "Caro"]);
  const c = card(repo.payments.pendingAll(800));

  assert.equal(c.people, 3);
  assert.equal(c.cents, 9_600_000);
  assert.equal(c.unpriced, 0, "a priced week is being called unpriced");
});

test("an empty farm still shows nothing, which is the honest silence", () => {
  const c = card(repo.payments.pendingAll(800));
  assert.equal(c.people, 0);
  assert.equal(c.unpriced, 0);
  assert.ok(!(c.people > 0 || c.unpriced > 0), "a farm with no work is claiming work");
});

test("a settled worker leaves the count, priced or not", () => {
  crew(["Ana"]);
  const [ana] = repo.payments.pendingAll(800);
  repo.payments.settle(ana!.personId, "1970-01-01", "2099-12-31", 800);

  assert.equal(card(repo.payments.pendingAll(800)).people, 0);
  assert.equal(card(repo.payments.pendingAll(0)).unpriced, 0,
    "a settled week is being reported as unpriced");
});

// ---- The screen actually computes it this way -----------------------------

test("Home counts the unpriced rows instead of filtering them away", () => {
  const src = readFileSync(
    join(new URL(".", import.meta.url).pathname, "../screens/Home.tsx"),
    "utf8",
  );

  const load = src.slice(src.indexOf("const load = useCallback"), src.indexOf("useFocusEffect(load)"));
  assert.ok(load.length > 0, "Home's load has moved; this pin needs rewriting");

  // The shape that shipped the bug: filter inline, keeping nothing else.
  assert.doesNotMatch(
    load,
    /pendingAll\([^)]*\)\s*\.filter/,
    "Home is filtering pendingAll inline again, so unpriced rows are lost",
  );
  assert.match(load, /amountCents <= 0 && r\.kg > 0/, "Home no longer counts unpriced rows");
  assert.match(load, /unpriced/, "Home does not carry the unpriced count into state");

  // And it renders on either reason, not only on money.
  assert.match(
    src,
    /pending\.unpriced > 0/,
    "the card no longer renders for a farm whose weeks are unpriced",
  );
});
