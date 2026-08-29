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
