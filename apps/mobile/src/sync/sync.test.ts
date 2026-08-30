/**
 * The sync engine, tested against what actually goes wrong in a lote.
 *
 * Not "does a push call fetch". The cases below are the ones the farm will
 * meet: a week without signal, a network that dies halfway through a batch,
 * the same weighing sent twice, two handsets handing cash to the same person,
 * and a settlement made in the office while the phone was in a field.
 *
 * Every one of them runs against the REAL repository — the real migrations,
 * the real outbox triggers, the real `BALANCE_SQL` — over `node:sqlite`, with
 * a fake transport standing in for the network. That is the only arrangement
 * in which "nothing is lost and nothing is duplicated" means anything: a test
 * that mocked the repository would be checking that a mock does what it was
 * told.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "../data/nodeSqlite.ts";
import { createSqliteRepository } from "../data/sqliteRepository.ts";
import type { Repository } from "../data/repository.ts";
import { SyncEngine } from "./engine.ts";
import { backoffMs, dispositionOf, type OpResult, type PullChange, type PushResult, type SyncOp, type SyncTransport } from "./protocol.ts";

// ---- A server that does what we tell it --------------------------------

interface FakeServerOptions {
  /** Fail the Nth envelope of a push (1-based) by throwing, as a socket does. */
  dieAfter?: number;
  /** Answers keyed by entity, for the cases that need a specific refusal. */
  refuse?: Record<string, { code: string; message: string; details?: Record<string, unknown> }>;
}

/**
 * A server that remembers every id it was given.
 *
 * The `seen` set is the point: it is the server's `ON CONFLICT (id) DO
 * NOTHING`, which is §4.1's first layer and the one that actually stops a
 * retry becoming a second payment. A test that let the fake accept the same
 * id twice would prove nothing about the property being claimed.
 */
class FakeServer {
  seen = new Set<string>();
  pushes: SyncOp[][] = [];
  changes: PullChange[] = [];
  balances: { workerId: string; balanceCents: number }[] = [];
  timezone = "America/Bogota";
  opts: FakeServerOptions;
  private pulls = 0;

  constructor(opts: FakeServerOptions = {}) {
    this.opts = opts;
  }

  transport(): SyncTransport {
    return {
      handshake: async () => ({
        farmId: "farm-1",
        farmName: "La Esperanza",
        timezone: this.timezone,
        currency: "COP",
        role: "owner" as const,
        capabilities: {
          settleOffline: false,
          writePlots: false,
          writeWeekPrices: false,
          money: true,
        },
        cursor: null,
        behind: 0,
        serverTime: "2026-08-29T12:00:00.000Z",
      }),

      push: async ({ ops }): Promise<PushResult> => {
        this.pushes.push(ops);
        const results: OpResult[] = [];
        let n = 0;
        for (const op of ops) {
          n++;
          if (this.opts.dieAfter !== undefined && n > this.opts.dieAfter) {
            // The socket closes. Everything already applied stays applied —
            // which is exactly what a real half-delivered batch leaves behind,
            // and the reason the caller cannot assume "the request failed"
            // means "nothing happened".
            throw Object.assign(new Error("sin conexión"), {
              name: "ApiError",
              code: "NETWORK",
            });
          }
          const refusal = this.opts.refuse?.[op.entity];
          if (refusal) {
            results.push({ opId: op.opId, status: "rejected", id: op.id, error: refusal });
            continue;
          }
          const known = this.seen.has(op.id);
          this.seen.add(op.id);
          results.push({ opId: op.opId, status: known ? "duplicate" : "applied", id: op.id });
        }
        return { results, cursor: null };
      },

      pull: async () => {
        // Everything, every time. The REST transport behaves the same way —
        // there is no feed to consume, only tables to re-read — and it is the
        // harder case for the phone: applying the same change twice has to be
        // a no-op, and if it is not, these tests will say so.
        this.pulls++;
        return {
          changes: this.changes,
          cursor: JSON.stringify({ at: "2026-08-29T12:00:00.000Z", since: 1 }),
          more: false,
          balances: this.balances,
          skipped: [],
        };
      },
    };
  }
}

// ---- A phone -----------------------------------------------------------

function aPhone(): { db: DatabaseSync; repo: Repository } {
  const db = new DatabaseSync(":memory:");
  const repo = createSqliteRepository(nodeSqlite(db), {
    timezone: "America/Bogota",
  });
  repo.init();
  return { db, repo };
}

function aWorker(repo: Repository, name = "Ana"): number {
  return repo.people.add({
    name,
    lastName: "Rodríguez",
    documentType: "CC",
    docId: "1098",
    tag: "17",
    image: "",
  }).lastInsertRowId;
}

function aPlot(repo: Repository): number {
  return repo.crops.add({
    name: "La Cuchilla",
    type: "cafe",
    variety: "Castillo",
    dimension: 2.5,
  }).lastInsertRowId;
}

const uuidOf = (db: DatabaseSync, table: string, id: number): string =>
  (db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id) as { uuid: string }).uuid;

const engineFor = (repo: Repository, server: FakeServer) =>
  new SyncEngine({ repo, transport: server.transport(), random: () => 0.5 });

// ---- Days without signal ------------------------------------------------

test("a week in a lote with no signal drains completely, in batches", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);

  // Six days of weighing, three loads a day, plus the cash handed over on
  // Saturday. Nothing has ever reached a server.
  for (let d = 6; d >= 1; d--)
    for (let k = 0; k < 3; k++)
      repo.pickups.add({
        personId: person,
        cropId: plot,
        weight: 40 + k,
        date: new Date(Date.UTC(2026, 7, 17 + (6 - d), 14 + k)).toISOString(),
      });
  repo.payments.advance(person, 5_000_00, "adelanto en el lote");

  const owed = repo.sync.pendingCount();
  const unsendable = countUnsendable(db);
  assert.ok(owed >= 20, `expected a real backlog, got ${owed}`);

  const server = new FakeServer();
  const report = await engineFor(repo, server).sync();

  assert.equal(report.ok, true, report.error?.message ?? "");
  assert.equal(repo.sync.pendingCount(), 0, "the queue emptied");
  // Every row that travels, and exactly once each.
  assert.equal(server.seen.size, owed - unsendable, "one id per owed row");
  assert.equal(report.conflicts, 0);
});

/** Rows queued for tables that do not travel upwards (§2). */
function countUnsendable(db: DatabaseSync): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE entity IN ('config')")
      .get() as { n: number }
  ).n;
}

// ---- The network dies mid-batch ----------------------------------------

test("a push cut in half keeps what landed and never sends it twice", async () => {
  const { repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  for (let i = 0; i < 10; i++)
    repo.pickups.add({
      personId: person,
      cropId: plot,
      weight: 40 + i,
      date: new Date(Date.UTC(2026, 7, 24, 12 + i)).toISOString(),
    });

  // The socket closes after the fourth envelope. The server keeps those four.
  const dying = new FakeServer({ dieAfter: 4 });
  const first = await engineFor(repo, dying).sync();
  assert.equal(first.ok, false, "the run reports the failure");
  assert.ok(first.error, "and says what it was");
  const landed = dying.seen.size;
  assert.equal(landed, 4, "four envelopes were applied before the socket closed");

  // Nothing was acked, because no result came back for them. The phone is
  // about to resend all ten — which is the whole reason idempotency exists.
  assert.ok(repo.sync.pendingCount() >= 10, "nothing was dropped on optimism");

  // The retry. The four that landed come back as `duplicate`; the server does
  // NOT grow four extra rows.
  const alive = new FakeServer();
  alive.seen = dying.seen;
  const engine = engineFor(repo, alive);
  const second = await engine.sync({ force: true });

  assert.equal(second.ok, true, second.error?.message ?? "");
  assert.equal(repo.sync.pendingCount(), 0);
  assert.equal(
    alive.seen.size,
    landed + 6 + 2,
    "the four that landed were not written a second time (plus the worker and the plot)",
  );
});

test("the same row pushed twice is one row on the server and one here", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const pickup = repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 12.5,
    date: "2026-08-24T19:30:00.000Z",
  }).lastInsertRowId;
  const id = uuidOf(db, "pickups", pickup);

  const server = new FakeServer();
  await engineFor(repo, server).sync();
  const after = server.seen.size;

  // Same phone, same weighing, sent again — which is what a user tapping
  // "sincronizar ahora" twice does. The uuid was minted when the button was
  // pressed, not when the request was built, so there is no second one to
  // invent.
  repo.pickups.setWeight(pickup, 13.0);
  await engineFor(repo, server).sync({ force: true });

  assert.equal(server.seen.size, after, "no new id appeared");
  assert.ok(server.seen.has(id));
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM pickups").get() as { n: number }).n,
    1,
  );
});

// ---- Two handsets, one worker ------------------------------------------

test("two phones both hand cash to the same worker and both advances survive", async () => {
  // §6.2: an advance claims no weighing, takes no lock, and two devices that
  // record one merge by union. This is the property the whole "no settling
  // offline" decision rests on, so it is worth pinning rather than assuming.
  const a = aPhone();
  const b = aPhone();
  const server = new FakeServer();

  const personA = aWorker(a.repo);
  const personUuid = uuidOf(a.db, "people", personA);
  a.repo.payments.advance(personA, 50_000_00, "anticipo en el lote");
  await engineFor(a.repo, server).sync();

  // The second handset has the same worker (it pulled them) and gives more.
  const personB = aWorker(b.repo, "Ana");
  b.db.prepare("UPDATE people SET uuid = ? WHERE id = ?").run(personUuid, personB);
  b.repo.payments.advance(personB, 30_000_00, "otro anticipo");
  await engineFor(b.repo, server).sync();

  // Two distinct ids on the server: two facts, not a conflict.
  const advances = [...server.seen].length;
  assert.ok(advances >= 2);
  assert.equal(
    a.repo.payments.balance(personA).balanceCents,
    -50_000_00,
    "each phone still knows what IT handed over",
  );
  assert.equal(b.repo.payments.balance(personB).balanceCents, -30_000_00);
});

// ---- A settlement made on the web while the phone was away -------------

test("a settlement made in the office lands on a phone that was in a field", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const pickup = repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 50,
    date: "2026-08-25T14:00:00.000Z",
  }).lastInsertRowId;

  const personUuid = uuidOf(db, "people", person);
  const pickupUuid = uuidOf(db, "pickups", pickup);
  const server = new FakeServer();
  await engineFor(repo, server).sync();

  // The owner settles that week on the web. The document, its line and the
  // devengo all come down — §3.3, a settlement travels whole.
  server.changes = [
    {
      seq: 1,
      entity: "settlement",
      row: {
        id: "sett-1",
        workerId: personUuid,
        periodStart: "2026-08-24",
        periodEnd: "2026-08-30",
        grossCents: 4_000_000,
        status: "open",
        note: null,
        createdAt: "2026-08-29T10:04:00.000Z",
        voidedAt: null,
        items: [
          {
            id: "sett-1:item",
            payableId: pickupUuid,
            weekStart: "2026-08-24",
            quantity: 50,
            priceCents: 80_000,
            amountCents: 4_000_000,
            voidedAt: null,
          },
        ],
      },
    },
    {
      seq: 2,
      entity: "ledgerEntry",
      row: {
        id: "led-1",
        workerId: personUuid,
        kind: "devengo",
        amountCents: 4_000_000,
        date: "2026-08-29",
        settlementId: "sett-1",
        method: null,
        note: null,
        reversesId: null,
        createdAt: "2026-08-29T10:04:00.000Z",
      },
    },
  ];
  server.balances = [{ workerId: personUuid, balanceCents: 4_000_000 }];

  const report = await engineFor(repo, server).sync({ force: true });
  assert.equal(report.ok, true, report.error?.message ?? "");
  assert.equal(report.applied?.settlements, 1);
  assert.equal(report.applied?.ledger, 1);

  // The phone's own arithmetic agrees with the server's, which is what the
  // checksum is for — and it is NOT the number that was copied.
  assert.equal(repo.payments.balance(person).balanceCents, 4_000_000);
  assert.equal(report.mismatched, 0, "no card was raised");

  // And the weighing is claimed, so it cannot be settled a second time here.
  assert.equal(repo.pickups.isSettled(pickup), true);
  assert.equal(
    repo.payments.preview(person, "1970-01-01", "2100-01-01", 800).pickupCount,
    0,
  );
});

test("a settlement voided on the web leaves the payment standing, and the debt", async () => {
  // §5.4 and golden case 05. Annulling releases the lock and reverses the
  // earning; the cash the pesador already handed over is NOT touched, so the
  // worker ends up owing it back. That is correct and it is the whole point.
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const pickup = repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 50,
    date: "2026-08-25T14:00:00.000Z",
  }).lastInsertRowId;
  const personUuid = uuidOf(db, "people", person);
  const pickupUuid = uuidOf(db, "pickups", pickup);

  const server = new FakeServer();
  const settlement = (status: "open" | "void", voidedAt: string | null): PullChange => ({
    seq: 1,
    entity: "settlement",
    row: {
      id: "sett-1",
      workerId: personUuid,
      periodStart: "2026-08-24",
      periodEnd: "2026-08-30",
      grossCents: 4_000_000,
      status,
      note: null,
      createdAt: "2026-08-29T10:04:00.000Z",
      voidedAt,
      items: [
        {
          id: "sett-1:item",
          payableId: pickupUuid,
          weekStart: "2026-08-24",
          quantity: 50,
          priceCents: 80_000,
          amountCents: 4_000_000,
          voidedAt: null,
        },
      ],
    },
  });

  server.changes = [
    settlement("open", null),
    {
      seq: 2,
      entity: "ledgerEntry",
      row: {
        id: "led-1", workerId: personUuid, kind: "devengo", amountCents: 4_000_000,
        date: "2026-08-29", settlementId: "sett-1", method: null, note: null,
        reversesId: null, createdAt: "2026-08-29T10:04:00.000Z",
      },
    },
  ];
  await engineFor(repo, server).sync();

  // The pesador pays it out in the lote.
  repo.payments.pay(person, 4_000_000, { settlementId: settlementLocalId(db) });
  assert.equal(repo.payments.balance(person).balanceCents, 0);

  // The owner voids it on the web. The reverso comes down with it.
  const later = new FakeServer();
  later.changes = [
    settlement("void", "2026-08-30T09:00:00.000Z"),
    {
      seq: 2,
      entity: "ledgerEntry",
      row: {
        id: "led-2", workerId: personUuid, kind: "reverso", amountCents: -4_000_000,
        date: "2026-08-30", settlementId: "sett-1", method: null, note: "anulada",
        reversesId: "led-1", createdAt: "2026-08-30T09:00:00.000Z",
      },
    },
  ];
  await engineFor(repo, later).sync({ force: true });

  assert.equal(
    repo.payments.balance(person).balanceCents,
    -4_000_000,
    "the worker owes back what they were paid against a document that no longer exists",
  );
  // And the weighing is free again, so it rolls into the next settlement.
  assert.equal(repo.pickups.isSettled(pickup), false);
});

const settlementLocalId = (db: DatabaseSync): number =>
  (db.prepare("SELECT id FROM settlements WHERE uuid = 'sett-1'").get() as { id: number }).id;

// ---- The loop that would never end -------------------------------------

test("what came down does not go straight back up", async () => {
  // Without the `sync_apply` guard the outbox triggers queue every row a pull
  // writes, the next push sends them all back, that push changes rows on the
  // server, and the farm has a loop that burns a data plan and never empties
  // a queue. This is the test that would catch its removal.
  const { repo } = aPhone();
  const server = new FakeServer();
  await engineFor(repo, server).sync();
  assert.equal(repo.sync.pendingCount(), 0);

  server.changes = [
    {
      seq: 1,
      entity: "worker",
      row: {
        id: "w-from-web",
        name: "Juan",
        lastName: "Pérez",
        documentType: "CC",
        docId: "1000",
        tag: null,
        deletedAt: null,
      },
    },
  ];
  const report = await engineFor(repo, server).sync({ force: true });

  assert.equal(report.applied?.workers, 1, "the worker arrived");
  assert.equal(repo.people.all().some((p) => p.name === "Juan"), true);
  assert.equal(repo.sync.pendingCount(), 0, "and owes the server nothing");
});

test("a pull does not overwrite a change this phone has not sent yet", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const uuid = uuidOf(db, "people", person);

  // Never synced: the worker is still queued. The web's older spelling must
  // not win, because the phone's version is the only copy of itself.
  const server = new FakeServer();
  server.changes = [
    {
      seq: 1,
      entity: "worker",
      row: {
        id: uuid,
        name: "ANA",
        lastName: "RODRIGUEZ",
        documentType: "CC",
        docId: "0000",
        tag: null,
        deletedAt: null,
      },
    },
  ];
  // The push half is disabled by pointing at a server that refuses workers,
  // so the row is still owed when the pull lands.
  const stubborn = new FakeServer({
    refuse: { worker: { code: "INTERNAL", message: "boom" } },
  });
  stubborn.changes = server.changes;
  const report = await engineFor(repo, stubborn).sync();

  assert.equal(report.applied?.skippedPending, 1, "the incoming row was skipped");
  assert.equal(repo.people.byId(person)?.name, "Ana", "the local edit survived");
  assert.ok(repo.sync.pendingCount() > 0, "and is still owed to the server");
});

// ---- Conflicts ---------------------------------------------------------

test("a weighing the server has already paid raises a card, and keeps the change", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const pickup = repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 12.5,
    date: "2026-08-25T14:00:00.000Z",
  }).lastInsertRowId;

  const server = new FakeServer();
  await engineFor(repo, server).sync();

  // The weight is corrected in the field. The server says that weighing is
  // already inside a settlement — §5.7a: the server wins, and the phone SHOWS
  // the change rather than discarding it or applying it.
  repo.pickups.setWeight(pickup, 13.0);
  const refusing = new FakeServer({
    refuse: {
      workRecord: {
        code: "WORK_RECORD_SETTLED",
        message: "ya se pagó",
        details: { settlementId: "sett-9" },
      },
    },
  });
  refusing.seen = server.seen;
  const report = await engineFor(repo, refusing).sync({ force: true });

  assert.equal(report.conflicts, 1);
  const cards = repo.sync.conflicts();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.kind, "pickup-already-settled");
  // §7.3: a person, a date and a quantity. A card without them is not a card.
  assert.equal(cards[0]!.payload.person, "Ana Rodríguez");
  assert.ok(cards[0]!.payload.date);
  assert.equal(cards[0]!.payload.quantity, 13);
  assert.equal(cards[0]!.payload.settlementId, "sett-9");

  // The correction is still on the phone. It was not discarded.
  assert.equal(
    (db.prepare("SELECT weight FROM pickups WHERE id = ?").get(pickup) as { weight: number })
      .weight,
    13.0,
  );

  // And it does not raise a second card on the next attempt.
  repo.pickups.setWeight(pickup, 13.5);
  await engineFor(repo, refusing).sync({ force: true });
  assert.equal(repo.sync.conflicts().length, 1, "one card per problem, not per attempt");
});

test("a lote created on the phone is reported, not silently dropped", async () => {
  // Decision 6 costs something: a lote can no longer be opened from the lote.
  // What must not happen is that it disappears without anybody being told.
  const { repo } = aPhone();
  aPlot(repo);

  const server = new FakeServer();
  const engine = new SyncEngine({
    repo,
    // The REST transport is the one that knows lotes do not go up; the fake
    // above accepts anything, so this test uses a transport that answers the
    // way the real one does.
    transport: {
      ...server.transport(),
      push: async ({ ops }) => ({
        results: ops.map((op) =>
          op.entity === "plotCrop"
            ? {
                opId: op.opId,
                status: "unsendable" as const,
                id: op.id,
                error: { code: "READ_ONLY_ON_PHONE", message: "se administra en la web" },
              }
            : { opId: op.opId, status: "applied" as const, id: op.id },
        ),
        cursor: null,
      }),
    },
    random: () => 0.5,
  });
  await engine.sync();

  const cards = repo.sync.conflicts().filter((c) => c.kind === "read-only-on-phone");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.payload.table, "crops");
  assert.equal(repo.sync.pendingCount(), 0, "and the chip's number goes down");
});

test("a balance the two sides disagree about is a card, never a copied number", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  repo.payments.advance(person, 10_000_00, "anticipo");
  const uuid = uuidOf(db, "people", person);

  const server = new FakeServer();
  // The server says something else. §7.4: this is a bug between two
  // implementations of the same money, and the answer is to find out, not to
  // overwrite the phone with the server's figure.
  server.balances = [{ workerId: uuid, balanceCents: -999_999 }];
  const report = await engineFor(repo, server).sync();

  assert.equal(report.mismatched, 1);
  const card = repo.sync.conflicts().find((c) => c.kind === "balance-mismatch");
  assert.ok(card, "a card was raised");
  assert.equal(card!.payload.localCents, -10_000_00);
  assert.equal(card!.payload.serverCents, -999_999);
  assert.equal(
    repo.payments.balance(person).balanceCents,
    -10_000_00,
    "the phone did not copy the server's number",
  );
});

// ---- Decision 8 --------------------------------------------------------

test("a worker off the books who is weighed again comes back, on the record", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  repo.people.remove(person);
  assert.equal(repo.people.all().length, 0);

  const pickup = repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 41.2,
    date: "2026-08-26T14:00:00.000Z",
  }).lastInsertRowId;

  assert.equal(repo.people.all().length, 1, "they are back on the books");

  // The condition the owner's decision came with: it is RECORDED, with the
  // labour that caused it and the device that did it.
  const record = repo.sync.reactivations(person);
  assert.equal(record.length, 1);
  assert.equal(record[0]!.causeEntity, "pickups");
  assert.equal(record[0]!.causeUuid, uuidOf(db, "pickups", pickup));
  assert.equal(record[0]!.deviceId, repo.sync.identity().deviceId);
});

test("work arriving from the web also brings a removed worker back, on the record", async () => {
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const uuid = uuidOf(db, "people", person);
  const server = new FakeServer();
  await engineFor(repo, server).sync();
  repo.people.remove(person);

  server.changes = [
    {
      seq: 1,
      entity: "workRecord",
      row: {
        id: "wr-from-web",
        workerId: uuid,
        cropId: null,
        quantity: 30,
        occurredAt: "2026-08-27T14:00:00.000Z",
        note: null,
        deletedAt: null,
      },
    },
  ];
  const report = await engineFor(repo, server).sync({ force: true });

  assert.equal(report.applied?.reactivated, 1);
  assert.equal(repo.people.byId(person)?.deletedAt, null);
  assert.equal(repo.sync.reactivations(person)[0]!.causeUuid, "wr-from-web");
});

// ---- The retry policy ---------------------------------------------------

test("a server error backs off, and a success clears the backoff", async () => {
  const { repo } = aPhone();
  aWorker(repo);

  const broken: SyncTransport = {
    handshake: async () => {
      throw Object.assign(new Error("boom"), { name: "ApiError", code: "INTERNAL" });
    },
    push: async () => ({ results: [], cursor: null }),
    pull: async () => ({ changes: [], cursor: null, more: false }),
  };

  const now = new Date("2026-08-29T12:00:00.000Z");
  const engine = new SyncEngine({
    repo,
    transport: broken,
    now: () => now,
    random: () => 0.5,
  });
  const failed = await engine.sync();
  assert.equal(failed.ok, false);

  const state = repo.sync.state();
  assert.equal(state.attempts, 1);
  assert.ok(state.retryAt, "the next attempt is scheduled, not immediate");
  assert.ok(state.lastError?.includes("INTERNAL"));
  assert.equal(
    new SyncEngine({ repo, transport: broken, now: () => now }).canRun(),
    false,
    "and it will not run again before then",
  );

  // §4.3: no limit on the retries, and the wait grows. The rows do not expire.
  assert.ok(backoffMs(1, () => 1) < backoffMs(5, () => 0), "later attempts wait longer");
  assert.ok(backoffMs(50, () => 1) <= 15 * 60 * 1000, "and never longer than fifteen minutes");

  const server = new FakeServer();
  await engineFor(repo, server).sync({ force: true });
  const cleared = repo.sync.state();
  assert.equal(cleared.attempts, 0);
  assert.equal(cleared.retryAt, null);
  assert.equal(cleared.lastError, null);
  assert.ok(cleared.pulledAt, "and it recorded when it finished");
});

test("§4.3's table has no ambiguous cell", () => {
  const at = (status: OpResult["status"], code?: string): OpResult => ({
    opId: "x",
    status,
    error: code ? { code, message: "" } : undefined,
  });

  assert.equal(dispositionOf(at("applied")), "done");
  assert.equal(dispositionOf(at("duplicate")), "done");
  // A lock that can only be taken once, taken. That is success.
  assert.equal(dispositionOf(at("rejected", "PAYABLE_ALREADY_CLAIMED")), "done");
  assert.equal(dispositionOf(at("rejected", "ALREADY_REVERSED")), "done");
  assert.equal(dispositionOf(at("rejected", "SETTLEMENT_ALREADY_VOID")), "done");
  // A person decides.
  assert.equal(dispositionOf(at("rejected", "WORK_RECORD_SETTLED")), "conflict");
  // A bug in this client. Never retried — a loop against a 400 eats a battery.
  assert.equal(dispositionOf(at("rejected", "BAD_REQUEST")), "conflict");
  // A parent that has not arrived yet.
  assert.equal(dispositionOf(at("rejected", "NOT_FOUND")), "retry");
  // Credentials stop everything.
  assert.equal(dispositionOf(at("rejected", "UNAUTHORIZED")), "halt");
  assert.equal(dispositionOf(at("rejected", "FORBIDDEN")), "halt");
  // And anything unheard of retries rather than being dropped.
  assert.equal(dispositionOf(at("rejected", "SOMETHING_NEW")), "retry");
  assert.equal(dispositionOf(at("rejected", "INTERNAL")), "retry");
});

test("two runs cannot overlap", async () => {
  const { repo } = aPhone();
  aWorker(repo);
  const server = new FakeServer();
  const engine = engineFor(repo, server);
  const [a, b] = await Promise.all([engine.sync(), engine.sync()]);
  // The same run, not two. Two concurrent drains would read the same outbox
  // rows and push them twice.
  assert.equal(a, b);
  assert.equal(server.pushes.length, 1);
});

// ---- What the sync left half-done --------------------------------------

test("a pull cut short by the page cap is not written down as complete", async () => {
  // §6.1: the phone does not settle without having synchronised. `pulledAt`
  // is what `canSettle` reads to decide that, and it used to be written after
  // EVERY pull — including one that stopped at `maxPages` with the server
  // still holding changes.
  //
  // The farm that meets this is the one that comes back after a fortnight out
  // of signal: twenty pages drain, thousands of changes are still up there,
  // and the screen says "al día" while the settle button goes live. The
  // weighings still to come down are exactly the ones that decide what the
  // week is worth.
  const { db, repo } = aPhone();

  let pulls = 0;
  const endless: SyncTransport = {
    handshake: async () => ({
      farmId: "farm-1",
      farmName: "La Esperanza",
      timezone: "America/Bogota",
      currency: "COP",
      role: "owner" as const,
      capabilities: {
        settleOffline: false,
        writePlots: false,
        writeWeekPrices: false,
        money: true,
      },
      cursor: null,
      behind: 5000,
      serverTime: "2026-08-29T12:00:00.000Z",
    }),
    push: async () => ({ results: [], cursor: null }),
    pull: async () => {
      pulls++;
      // Always more. The server has a fortnight of a farm on it.
      return { changes: [], cursor: `c${pulls}`, more: true, skipped: [] };
    },
  };

  const engine = new SyncEngine({ repo, transport: endless, maxPages: 3 });
  const report = await engine.sync({ force: true });

  assert.equal(pulls, 3, "it stopped where it was told, which is a courtesy, not a failure");
  assert.equal(report.stillBehind, true, "and it says so");
  assert.equal(report.behind, 5000, "§3.1: a number, not a spinner");
  assert.equal(
    repo.sync.state().pulledAt,
    null,
    "not written down as up to date, because it is not",
  );
  // The cursor DID move: what came down is applied and will not come again.
  assert.equal(repo.sync.state().cursor, "c3");

  // Now the server runs out. Only then is the phone level.
  let left = 1;
  const finishing: SyncTransport = {
    ...endless,
    pull: async () => {
      const more = left-- > 0;
      return { changes: [], cursor: "final", more, skipped: [] };
    },
  };
  const done = await new SyncEngine({ repo, transport: finishing, maxPages: 3 }).sync({
    force: true,
  });
  assert.equal(done.stillBehind, false);
  assert.ok(repo.sync.state().pulledAt, "now it is");
  db.close();
});

test("a pull that finishes clean is still written down, and the balance is compared", async () => {
  // The guard above must not have turned every ordinary sync into an
  // incomplete one: `more: false` is the normal answer and it still counts.
  const { db, repo } = aPhone();
  const server = new FakeServer();
  const engine = new SyncEngine({ repo, transport: server.transport() });

  const report = await engine.sync({ force: true });
  assert.equal(report.ok, true);
  assert.equal(report.stillBehind, false);
  assert.ok(repo.sync.state().pulledAt);
  db.close();
});

// ---- Decision 7: the full balance --------------------------------------

test("the balance on show includes the jornales the phone cannot break down", async () => {
  // §2.2 and decision 7. The web registers jornales and contracts, the pull
  // filters them out — the phone has no screen that could show a day's wage in
  // kilos — and so `BALANCE_SQL` here sums only the weighings. The owner's
  // decision is that the phone shows the FULL balance anyway: «a balance that
  // counts half the work is a balance that lies, and whoever reads it has no
  // way of knowing».
  //
  // Before this, the server's figure was compared and thrown away. The card
  // that came out of the comparison was the only trace of it, and the worker's
  // own screen went on showing half.
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const uuid = repo.people.byId(person)!.uuid!;

  // What the phone knows: one week on the scale, settled and unpaid.
  repo.pickups.add({ personId: person, cropId: plot, weight: 50, date: "2026-08-25T14:00:00.000Z" });
  repo.payments.settle(person, "1970-01-01", "2099-12-31", 800);
  const itemised = repo.payments.balance(person).balanceCents;
  assert.ok(itemised > 0);

  // What the farm knows: the same week, plus two days of jornal booked in the
  // office. The feed carries the TOTAL and none of the movements behind it.
  const server = new FakeServer();
  const jornalCents = 12_000_00;
  server.balances = [{ workerId: uuid, balanceCents: itemised + jornalCents }];

  const before = repo.payments.fullBalance(person);
  assert.equal(before.serverCents, null, "it has not talked to anybody yet");
  assert.equal(before.balanceCents, itemised, "and it shows the only thing it has");

  const report = await engineFor(repo, server).sync({ force: true });
  assert.equal(report.ok, true);

  const full = repo.payments.fullBalance(person);
  assert.equal(full.itemisedCents, itemised, "what the phone can break down");
  assert.equal(full.serverCents, itemised + jornalCents);
  assert.equal(full.balanceCents, itemised + jornalCents, "what is shown is the full one");
  assert.equal(full.notItemisableCents, jornalCents, "and it can say how much of it is jornal");
  assert.equal(full.provisional, false);
  assert.ok(full.serverAt, "§2.2: with the mark of when it arrived");

  // And the money that is HANDED OVER is still derived from this phone's own
  // ledger, movement by movement. Paying out a figure that arrived on the wire
  // would be handing cash for work whose breakdown the receipt cannot print,
  // and that is the owner's call, not this file's.
  assert.equal(repo.payments.balance(person).balanceCents, itemised);
  db.close();
});

test("while anything is still unsent, the balance on show is the phone's, and it says so", async () => {
  // §7.4, word for word: «Saldo $340.000 · provisional, faltan 4 movimientos
  // por enviar». The received figure is a moment behind the instant somebody
  // handed over cash in a lote, and showing it as if it were current would
  // tell a pesador they still owe money they just paid.
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const uuid = repo.people.byId(person)!.uuid!;

  repo.pickups.add({ personId: person, cropId: plot, weight: 50, date: "2026-08-25T14:00:00.000Z" });
  repo.payments.settle(person, "1970-01-01", "2099-12-31", 800);
  const itemised = repo.payments.balance(person).balanceCents;

  const server = new FakeServer();
  server.balances = [{ workerId: uuid, balanceCents: itemised + 12_000_00 }];
  await engineFor(repo, server).sync({ force: true });
  assert.equal(repo.payments.fullBalance(person).provisional, false);

  // The pesador hands over cash. Nothing has been pushed yet.
  repo.payments.pay(person, 10_000_00, { method: "efectivo" });
  assert.ok(repo.sync.pendingCount() > 0);

  const now = repo.payments.fullBalance(person);
  assert.equal(now.provisional, true);
  assert.equal(
    now.balanceCents,
    repo.payments.balance(person).balanceCents,
    "the derived one, which is the only one that knows about the payment a minute ago",
  );
  // The received figure is still there, so the screen can say what it was and
  // when — it just is not the headline any more.
  assert.equal(now.serverCents, itemised + 12_000_00);
  assert.ok(now.serverAt);
  db.close();
});

test("the received balance is not stored while the phone is not level", async () => {
  // The guard that keeps this from becoming the materialised balance three
  // documents refused: a figure recorded while the outbox still had rows in it
  // would describe a moment that never existed on either side.
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const uuid = repo.people.byId(person)!.uuid!;
  repo.pickups.add({ personId: person, cropId: plot, weight: 50, date: "2026-08-25T14:00:00.000Z" });

  // A server that refuses every weighing with a code §4.3 leaves queued, so
  // the outbox never empties.
  const stubborn = new FakeServer({
    refuse: { workRecord: { code: "RATE_LIMITED", message: "espera" } },
  });
  stubborn.balances = [{ workerId: uuid, balanceCents: 99_999_00 }];

  const report = await engineFor(repo, stubborn).sync({ force: true });
  assert.ok(report.retrying > 0, "there is still something to send");
  assert.equal(report.mismatched, 0, "and nothing is compared, which would be crying wolf");
  assert.equal(
    repo.payments.fullBalance(person).serverCents,
    null,
    "nor is a figure stored about a moment that never existed",
  );
  db.close();
});

// ---- The two codes that retried for ever, sprint 8 ----------------------

test("a document already belonging to somebody off the books stops retrying and asks for a person", async () => {
  // `EMPLOYEE_EXISTS_DELETED`, checked against the API rather than assumed.
  //
  // The reading last sprint was that decision 8 would sort this out on the
  // next attempt, because a worker off the books who does new work is put back
  // on. It does not. `handleCreateWorker` looks the document up with
  // `FindDeletedByDocument` BEFORE inserting, and that lookup answers the same
  // way for ever; decision 8's `ReactivateForWork` is reached only from a work
  // record, and never from a worker. So this envelope retried, and every
  // weighing queued behind that worker retried with it, until somebody looked
  // at a chip that never went down.
  const { repo } = aPhone();
  const person = aWorker(repo);

  const refusing = new FakeServer({
    refuse: {
      worker: {
        code: "EMPLOYEE_EXISTS_DELETED",
        message: "a worker with that document is on this farm, deactivated",
        details: {
          employeeId: "0192e2aa-0000-7000-8000-000000000001",
          name: "Ana",
          lastName: "Rodríguez R.",
          deletedAt: "2026-07-01T10:00:00Z",
        },
      },
    },
  });

  const report = await engineFor(repo, refusing).sync({ force: true });

  assert.equal(report.conflicts, 1, "a card, not a retry");
  assert.equal(repo.sync.pendingCount(), 0, "and it leaves the queue instead of spinning in it");

  const card = repo.sync.conflicts().find((c) => c.kind === "worker-exists-deleted");
  assert.ok(card, "with its card");
  assert.equal(card!.payload.person, "Ana Rodríguez");
  assert.equal(card!.payload.serverName, "Ana Rodríguez R.", "both names, to compare");
  assert.equal(card!.payload.serverWorkerId, "0192e2aa-0000-7000-8000-000000000001");

  // And nothing merged the two people. The phone's worker is untouched, with
  // its own uuid: joining them is a decision for whoever knows them both, on
  // the screen where restoring the old file is a button.
  assert.equal(repo.people.byId(person)?.name, "Ana");

  // A second run does not raise a second card for the same problem.
  await engineFor(repo, refusing).sync({ force: true });
  assert.equal(
    repo.sync.conflicts().filter((c) => c.kind === "worker-exists-deleted").length,
    1,
  );
});

test("a settlement whose figure moved is not resent on its own, and the card says what moved", async () => {
  // `GROSS_CHANGED`. The envelope carries the gross this phone computed, so
  // resending it asks the same question and gets the same answer for ever.
  //
  // The card reads the server's own `payableIdsProvided`. That flag is the
  // difference between «two weighings came in» and «the server was not told
  // what you were looking at», and showing the first when it is the second is
  // how a screen blames a reprice for a late weighing.
  const { repo } = aPhone();
  const person = aWorker(repo);
  repo.payments.advance(person, 5_000_00, "anticipo");

  const refusing = new FakeServer({
    refuse: {
      ledgerEntry: {
        code: "GROSS_CHANGED",
        message: "the settlement no longer adds up to the figure the caller was shown",
        details: {
          expectedCents: 1_187_500,
          actualCents: 1_265_000,
          addedPayableIds: ["0192e2aa-0000-7000-8000-00000000000a"],
          removedPayableIds: [],
          weeksInSettlement: [{ weekStart: "2026-08-24", priceCents: 95_000 }],
          payableIdsProvided: true,
        },
      },
    },
  });

  const report = await engineFor(repo, refusing).sync({ force: true });

  assert.equal(report.conflicts, 1);
  assert.equal(repo.sync.pendingCount(), 0, "it does not stay spinning in the queue");

  const card = repo.sync.conflicts().find((c) => c.kind === "gross-changed");
  assert.ok(card);
  assert.equal(card!.payload.expectedCents, 1_187_500);
  assert.equal(card!.payload.actualCents, 1_265_000);
  assert.equal(card!.payload.addedCount, 1);
  assert.equal(card!.payload.removedCount, 0);
  assert.equal(card!.payload.explained, true);
});

test("without payableIds the server cannot know what moved, and the card does not invent it", async () => {
  const { repo } = aPhone();
  const person = aWorker(repo);
  repo.payments.advance(person, 5_000_00, "anticipo");

  const refusing = new FakeServer({
    refuse: {
      ledgerEntry: {
        code: "GROSS_CHANGED",
        message: "the settlement no longer adds up",
        details: {
          expectedCents: 1_187_500,
          actualCents: 1_265_000,
          // The server's own words: empty lists here mean «we were not told
          // what you were looking at», never «nothing moved».
          addedPayableIds: [],
          removedPayableIds: [],
          payableIdsProvided: false,
        },
      },
    },
  });

  await engineFor(repo, refusing).sync({ force: true });
  const card = repo.sync.conflicts().find((c) => c.kind === "gross-changed");
  assert.ok(card);
  assert.equal(card!.payload.explained, false, "and the screen says it that way");
});

// ---- The mixed case ----------------------------------------------------

test("a jornal that comes down inside a settlement can be measured, not guessed", async () => {
  // The mixed case of §2.2, closed.
  //
  // `composeSettlement` on the server «sends the header WITH ITS LINES,
  // always», and `composeWorkRecord` returns nothing for anything that is not
  // paid by the unit of work. So a settlement covering a week in which the
  // worker also did a jornal arrives with a `grossCents` bigger than the lines
  // this phone can resolve — and that difference IS «what the phone cannot
  // break down», in cents, measured off a document the server issued.
  //
  // Before this it was inferred from whether the phone's own balance happened
  // to be zero, which put every worker with BOTH kinds of work in the wrong
  // bucket and reported their ordinary payroll as a calculation bug.
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const plot = aPlot(repo);
  const workerUuid = uuidOf(db, "people", person);
  const cropUuid = uuidOf(db, "crops", plot);

  const server = new FakeServer();
  const pesadaUuid = "0192e2aa-0000-7000-8000-0000000000a1";
  const jornalUuid = "0192e2aa-0000-7000-8000-0000000000a2";
  const pesadaCents = 4_000_00;
  const jornalCents = 12_000_00;

  server.changes = [
    // The weighing behind the first line. The jornal behind the second never
    // comes down — that is §2.2, and it is the whole point.
    {
      seq: 1,
      entity: "workRecord",
      row: {
        id: pesadaUuid,
        workerId: workerUuid,
        cropId: cropUuid,
        quantity: 50,
        occurredAt: "2026-08-25T14:00:00.000Z",
        note: null,
        deletedAt: null,
      },
    },
    {
      seq: 2,
      entity: "settlement",
      row: {
        id: "0192e2aa-0000-7000-8000-0000000000b1",
        workerId: workerUuid,
        periodStart: "2026-08-24",
        periodEnd: "2026-08-30",
        grossCents: pesadaCents + jornalCents,
        status: "open",
        note: null,
        createdAt: "2026-08-30T10:00:00.000Z",
        voidedAt: null,
        items: [
          {
            id: "0192e2aa-0000-7000-8000-0000000000c1",
            payableId: pesadaUuid,
            weekStart: "2026-08-24",
            quantity: 50,
            priceCents: 800,
            amountCents: pesadaCents,
            voidedAt: null,
          },
          {
            id: "0192e2aa-0000-7000-8000-0000000000c2",
            payableId: jornalUuid,
            weekStart: "2026-08-24",
            quantity: 2,
            priceCents: 600_000,
            amountCents: jornalCents,
            voidedAt: null,
          },
        ],
      },
    },
  ];

  // §3.4's horizon: a settlement and the `devengo` it posts are two rows of
  // the feed, and the second can be held back for the next poll. In that
  // window the phone is short by exactly the part of the document it cannot
  // break down — which is the one moment where crying "bug" would be wrong.
  server.balances = [{ workerId: workerUuid, balanceCents: jornalCents }];

  const report = await engineFor(repo, server).sync({ force: true });
  assert.equal(report.ok, true, report.error?.message ?? "");

  // The jornal line was dropped — there is no weighing to hang it on — and the
  // document kept its own gross.
  assert.ok(report.applied!.orphans >= 1, "the jornal line had nothing to hang from");

  const measured = repo.sync
    .balanceChecksums()
    .find((r) => r.uuid === workerUuid)!;
  assert.equal(
    measured.unitemisableCents,
    jornalCents,
    "and what could not be broken down can be stated to the cent",
  );

  // So the card is «the phone knows less», not «the two implementations do
  // not agree» — which is the distinction that could not be made before.
  const card = repo.sync.conflicts().find((c) => c.kind === "balance-not-itemisable");
  assert.ok(card, "the right card");
  assert.equal(card!.payload.unitemisableCents, jornalCents);
  assert.equal(
    repo.sync.conflicts().filter((c) => c.kind === "balance-mismatch").length,
    0,
    "and an ordinary payroll is not accused of a calculation bug",
  );
  db.close();
});

test("a difference bigger than the phone can account for is still a failure", async () => {
  // The other half, and the reason the rule is «covered by», not «there is
  // some». A peso more than the documents account for is the part that
  // matters, and it stays a mismatch.
  const { db, repo } = aPhone();
  const person = aWorker(repo);
  const uuid = uuidOf(db, "people", person);
  repo.payments.advance(person, 10_000_00, "anticipo");

  const server = new FakeServer();
  server.balances = [{ workerId: uuid, balanceCents: -9_999_99 }];
  const report = await engineFor(repo, server).sync({ force: true });

  assert.equal(report.mismatched, 1);
  assert.ok(repo.sync.conflicts().some((c) => c.kind === "balance-mismatch"));
  assert.equal(
    repo.sync.conflicts().filter((c) => c.kind === "balance-not-itemisable").length,
    0,
  );
  db.close();
});
