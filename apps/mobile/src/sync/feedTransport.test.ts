/**
 * The feed transport, tested against the contract rather than against itself.
 *
 * Everything asserted below is something `services/api/openapi.yaml` or
 * `internal/httpapi/handlers_sync.go` will actually do, and most of it is
 * something that fails LOUDLY on the server if the phone gets it wrong:
 * `decodePayload` refuses an unknown field, `sync_ops.op_id` is a `uuid`
 * primary key, `occurredAt` must be an RFC3339 instant and not a bare day, and
 * a `devengo` is refused outright. Each of those is a 400 discovered in a lote
 * if it is not a test discovered here.
 *
 * The engine, the outbox and the applies are not retested: they are the same
 * code they were with the REST shim, and `sync.test.ts` already drives them.
 * What is new is one file, so this suite is about that one file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { nodeSqlite } from "../data/nodeSqlite.ts";
import { createSqliteRepository } from "../data/sqliteRepository.ts";
import type { Repository } from "../data/repository.ts";
import { HttpClient } from "./http.ts";
import { FeedTransport, opUuid } from "./feedTransport.ts";
import { SyncEngine } from "./engine.ts";
import { isUuidV7 } from "../../../../packages/shared/src/uuid.ts";

// ---- A server that answers the three routes ----------------------------

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface FakeApiOptions {
  role?: "owner" | "admin" | "weigher";
  cursor?: number;
  behind?: number;
  changes?: unknown[];
  balances?: { workerId: string; balanceCents: number }[];
  /** Answer the first pull with 409 CURSOR_TOO_OLD, as a stale cursor does. */
  cursorTooOldOnce?: boolean;
  /** Refuse one envelope, keyed by the payload id. */
  rejectId?: { id: string; code: string; message: string };
}

function fakeApi(opts: FakeApiOptions = {}) {
  const calls: Recorded[] = [];
  let toldCursorTooOld = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/v1/sync/handshake"))
      return json(200, {
        farmId: "11111111-1111-7111-8111-111111111111",
        timezone: "America/Bogota",
        currency: "COP",
        minorUnit: 2,
        serverTime: "2026-08-29T12:00:00Z",
        cursor: opts.cursor ?? 149006,
        behind: opts.behind ?? 0,
        role: opts.role ?? "owner",
        capabilities: {
          settleOffline: false,
          writePlots: false,
          writeWeekPrices: false,
        },
      });

    if (url.includes("/v1/sync/push")) {
      const ops = (body?.ops ?? []) as {
        opId: string;
        payload: { id: string };
      }[];
      return json(200, {
        cursor: (opts.cursor ?? 149006) + ops.length,
        results: ops.map((o) =>
          opts.rejectId && o.payload.id === opts.rejectId.id
            ? {
                opId: o.opId,
                status: "rejected",
                error: { code: opts.rejectId.code, message: opts.rejectId.message },
              }
            : { opId: o.opId, status: "applied", id: o.payload.id },
        ),
      });
    }

    if (url.includes("/v1/sync/pull")) {
      if (opts.cursorTooOldOnce && !toldCursorTooOld) {
        toldCursorTooOld = true;
        return json(409, {
          error: {
            code: "CURSOR_TOO_OLD",
            message: "that cursor is older than the oldest change still retained",
            details: { oldestRetainedSeq: 900 },
          },
        });
      }
      return json(200, {
        changes: opts.changes ?? [],
        cursor: opts.cursor ?? 149006,
        more: false,
        balances: opts.balances,
      });
    }

    if (url.includes("/reverse")) return json(200, { id: body?.id });

    return json(404, { error: { code: "NOT_FOUND", message: url } });
  };

  const http = new HttpClient({
    baseUrl: "https://api.example",
    session: {
      current: () => ({
        accessToken: "t",
        refreshToken: "r",
        expiresAt: Date.now() + 3600_000,
        farmId: "farm",
        role: opts.role ?? "owner",
      }),
      refresh: async () => {
        throw new Error("no refresh in this test");
      },
      clear: () => {},
    },
    fetchImpl,
  });

  return { calls, transport: new FeedTransport({ http }) };
}

// ---- A phone -----------------------------------------------------------

function aPhone(): { db: DatabaseSync; repo: Repository } {
  const db = new DatabaseSync(":memory:");
  const repo = createSqliteRepository(nodeSqlite(db), { timezone: "America/Bogota" });
  repo.init();
  return { db, repo };
}

const uuidOf = (db: DatabaseSync, table: string, id: number): string =>
  (db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id) as { uuid: string }).uuid;

// ---- The handshake -----------------------------------------------------

test("the handshake brings the timezone, the cursor and how many changes are outstanding", async () => {
  const { calls, transport } = fakeApi({ behind: 412, cursor: 149006 });
  const hs = await transport.handshake({
    deviceId: "device-1",
    schemaVersion: 7,
    cursor: null,
  });

  assert.equal(hs.timezone, "America/Bogota");
  assert.equal(hs.cursor, "149006");
  assert.equal(hs.behind, 412, "§3.1: a number, not a spinner");
  assert.equal(hs.capabilities.settleOffline, false, "decision 5");
  assert.equal(hs.capabilities.money, true, "an owner reads money");

  // A phone that has never synced sends 0, which the feed reads as "everything"
  // and answers with the whole state — the feed was backfilled when it was
  // created, so a farm that predates synchronisation still bootstraps.
  assert.equal(calls[0]!.body!.cursor, 0);
  assert.equal(calls[0]!.body!.schemaVersion, 7);
});

test("the weigher does not read money, and the pull says so instead of pretending to be up to date", async () => {
  const { transport } = fakeApi({ role: "weigher" });
  await transport.handshake({ deviceId: "d", schemaVersion: 7, cursor: null });
  const hs = await transport.handshake({ deviceId: "d", schemaVersion: 7, cursor: null });
  assert.equal(hs.capabilities.money, false);

  const res = await transport.pull({ cursor: "0", limit: 500 });
  assert.ok(
    res.skipped!.some((s) => /dinero/.test(s.reason)),
    "the status screen has to be able to say what was not read",
  );
});

test("a cursor the previous version left written breaks nothing", async () => {
  // The REST shim wrote a JSON window into the same TEXT column. It means
  // nothing to the feed, and the only safe reading of a position this server
  // never issued is 0: read everything, upsert by uuid, lose nothing.
  const { calls, transport } = fakeApi();
  await transport.pull({
    cursor: JSON.stringify({ at: "2026-08-01T00:00:00.000Z", since: 3 }),
    limit: 500,
  });
  assert.match(calls[0]!.url, /cursor=0/);
});

test("a CURSOR_TOO_OLD is re-read from zero instead of skipping the gap", async () => {
  const { calls, transport } = fakeApi({ cursorTooOldOnce: true });
  const res = await transport.pull({ cursor: "12", limit: 500 });

  assert.equal(calls.length, 2, "it asked again");
  assert.match(calls[0]!.url, /cursor=12/);
  assert.match(calls[1]!.url, /cursor=0/);
  assert.equal(res.cursor, "149006");

  // And it SAYS so. Re-reading everything is not a decision anybody makes,
  // but staying quiet about it means the next handshake reports this phone as
  // the whole season behind with nothing to explain the jump — and a counter
  // that appears to have gone backwards is how somebody concludes the phone
  // lost the harvest.
  assert.equal(res.bootstrapped, true);
});

test("an ordinary pass does not claim everything came down again", async () => {
  const { transport } = fakeApi();
  const res = await transport.pull({ cursor: "12", limit: 500 });
  assert.equal(res.bootstrapped, false);
});

// ---- The push ----------------------------------------------------------

test("a weighing travels with the INSTANT, never with the farm's day", async () => {
  const { db, repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "Rodríguez",
    documentType: "CC",
    docId: "1098",
    tag: "17",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({
    name: "La Cuchilla",
    type: "cafe",
    variety: "Castillo",
    dimension: 2.5,
  }).lastInsertRowId;
  // A Sunday evening in Bogotá, which is Monday in UTC. Golden case 04: the
  // week it belongs to is decided by the FARM's zone, and the server's own
  // trigger derives it — so what travels has to be the instant.
  repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 42.5,
    date: "2026-08-24T01:30:00.000Z",
  });

  const { calls, transport } = fakeApi();
  const engine = new SyncEngine({ repo, transport, random: () => 0.5 });
  await engine.sync();

  const push = calls.find((c) => c.url.includes("/v1/sync/push"))!;
  const ops = push.body!.ops as {
    entity: string;
    op: string;
    opId: string;
    payload: Record<string, unknown>;
  }[];
  const record = ops.find((o) => o.entity === "workRecord")!;

  assert.equal(record.payload.occurredAt, "2026-08-24T01:30:00.000Z");
  assert.equal(record.op, "upsert");
  assert.equal(record.payload.id, uuidOf(db, "pickups", 1));
  assert.equal(record.payload.workerId, uuidOf(db, "people", person));
  assert.equal(record.payload.cropId, uuidOf(db, "crops", plot));
  assert.equal(record.payload.quantity, 42.5);
  // `decodePayload` refuses an unknown field, so this list is not a style
  // preference: one extra key is a 400 for that envelope.
  assert.deepEqual(Object.keys(record.payload).sort(), [
    "cropId",
    "deletedAt",
    "id",
    "note",
    "occurredAt",
    "quantity",
    "workerId",
  ]);
});

test("the opId is a uuid, the same on every resend and a different one after a correction", () => {
  const row = "0198f3e1-2a4c-7abc-8def-0123456789ab";
  const key = (rev: number) => `pickups:${row}:${rev}`;

  assert.equal(opUuid(key(1)), opUuid(key(1)), "a resend carries the same key");
  assert.notEqual(opUuid(key(1)), opUuid(key(2)), "a correction carries another");

  // `sync_ops.op_id` is a `uuid PRIMARY KEY`: the engine's readable key cannot
  // go on the wire, and whatever replaces it has to still BE a uuid.
  assert.ok(isUuidV7(opUuid(key(3))), "version 7, variant 10");

  // The reason this is a hash and not an arithmetic tweak of the row's uuid.
  // Inside one millisecond this generator hands out ADJACENT ids — the counter
  // lives in `rand_a` — and a derivation that bumped the last digits by the
  // revision would make one row's second envelope collide with another row's
  // first. A shared idempotency key is one act silently receiving the other's
  // recorded answer.
  const neighbour = "0198f3e1-2a4c-7abc-8def-0123456789ac";
  assert.notEqual(opUuid(key(1)), opUuid(`pickups:${neighbour}:0`));

  // Two thousand envelopes of one season, all distinct.
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++)
    seen.add(opUuid(`pickups:0198f3e1-2a4c-7abc-8def-${String(i).padStart(12, "0")}:1`));
  assert.equal(seen.size, 2000);

  // A different entity is a different act even for the same id, which is what
  // stops a worker's envelope answering for a weighing's.
  assert.notEqual(opUuid(`people:${row}:1`), opUuid(`pickups:${row}:1`));
});

test("a whole batch goes in a single request, not one per envelope", async () => {
  const { repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({ name: "L", type: "cafe", variety: "C", dimension: 1 })
    .lastInsertRowId;
  for (let i = 0; i < 30; i++)
    repo.pickups.add({
      personId: person,
      cropId: plot,
      weight: 40 + i,
      date: new Date(Date.UTC(2026, 7, 24, 12, i)).toISOString(),
    });

  const { calls, transport } = fakeApi();
  await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  const pushes = calls.filter((c) => c.url.includes("/v1/sync/push"));
  assert.equal(pushes.length, 1, "thirty weighings, one round trip");
  assert.ok((pushes[0]!.body!.ops as unknown[]).length >= 30);
  assert.equal(repo.sync.pendingCount(), 0, "and the queue emptied");
});

test("a movement of money travels with its sign, and a deducción with no method", async () => {
  const { repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  repo.payments.advance(person, 50_000_00, "anticipo en el lote");
  repo.payments.deduct(person, 10_000_00, "herramienta");

  const { calls, transport } = fakeApi();
  await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  const ops = (calls.find((c) => c.url.includes("/v1/sync/push"))!.body!.ops ?? []) as {
    entity: string;
    op: string;
    payload: Record<string, unknown>;
  }[];
  const money = ops.filter((o) => o.entity === "ledgerEntry");
  assert.equal(money.length, 2);
  assert.ok(money.every((o) => o.op === "append"), "§3.2: the ledger appends");

  const anticipo = money.find((o) => o.payload.kind === "anticipo")!;
  assert.ok(
    (anticipo.payload.amountCents as number) < 0,
    "the stored sign travels; the handler normalises it and never guesses",
  );
  const deduccion = money.find((o) => o.payload.kind === "deduccion")!;
  assert.equal(
    deduccion.payload.method,
    null,
    "a deduction has no payment method and the handler refuses one",
  );
  assert.deepEqual(Object.keys(deduccion.payload).sort(), [
    "amountCents",
    "date",
    "id",
    "kind",
    "method",
    "note",
    "workerId",
  ]);
});

test("a devengo does not leave the phone and raises a card instead of a 400", async () => {
  const { db, repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({ name: "L", type: "cafe", variety: "C", dimension: 1 })
    .lastInsertRowId;
  repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 50,
    date: "2026-08-24T14:00:00.000Z",
  });
  // A settlement made on this phone before decision 5 turned that off. Its
  // `devengo` is the server's to write, so it can never go up.
  repo.payments.settle(person, "2026-08-24", "2026-08-30", 800);

  const { calls, transport } = fakeApi();
  const report = await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  const ops = (calls.find((c) => c.url.includes("/v1/sync/push"))?.body?.ops ?? []) as {
    entity: string;
    payload: Record<string, unknown>;
  }[];
  assert.ok(
    !ops.some((o) => o.payload.kind === "devengo"),
    "it was never sent",
  );
  assert.ok(report.conflicts > 0, "and somebody is told about it");
  const cards = repo.sync.conflicts();
  assert.ok(cards.length > 0);
  // The change is not lost: the row is still on the phone and the card names it.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'devengo'").get() as {
      n: number;
    }).n,
    1,
  );
});

/**
 * The landmine, on the transport that actually runs.
 *
 * `master` already stopped the phone sending a `pago` — in `restTransport.ts`.
 * But `SyncProvider.engineFor` builds a `FeedTransport`, and the REST shim is
 * only kept for the season import and for a server with no `/v1/sync/*`. So
 * the fix was applied to the path that does not execute, and a payment made on
 * a Saturday still went up on its own: money on the server, weighings still
 * unclaimed in `ux_items_payable_live`, and a console that could settle and
 * pay them a second time.
 *
 * This test is here so the two transports cannot drift apart again silently.
 */
test("a pago does not travel alone: it goes with the settlement that justifies it", async () => {
  const { db, repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({ name: "L", type: "cafe", variety: "C", dimension: 1 })
    .lastInsertRowId;
  repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 50,
    date: "2026-08-24T14:00:00.000Z",
  });
  // A Saturday on the farm: settle the week, hand over the cash.
  repo.payments.settle(person, "2026-08-24", "2026-08-30", 800);
  repo.payments.pay(person, 40_000_00, { method: "efectivo" });
  // And an advance, which is the half that IS safe to send: it claims no
  // weighing, takes no lock, and amortises when the settlement is made.
  repo.payments.advance(person, 5_000_00);

  const { calls, transport } = fakeApi();
  const report = await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  const ops = (calls.find((c) => c.url.includes("/v1/sync/push"))?.body?.ops ?? []) as {
    entity: string;
    payload: Record<string, unknown>;
  }[];
  assert.ok(!ops.some((o) => o.payload.kind === "pago"), "the pago did not go out");
  assert.ok(!ops.some((o) => o.payload.kind === "devengo"), "nor the devengo");
  assert.ok(
    ops.some((o) => o.payload.kind === "anticipo"),
    "the anticipo does go out: it is the one that cannot be paid twice",
  );

  // Nothing is lost. Both rows are still on the handset, and that is where the
  // season import will find them.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind IN ('pago','devengo')").get() as {
      n: number;
    }).n,
    2,
  );
  assert.ok(report.conflicts > 0);
});

/**
 * And it does not sit in the outbox retrying for ever.
 *
 * `unsendable` is a different disposition from `rejected`: the engine drops
 * the entry rather than leaving it queued, because resending it would produce
 * the same refusal until the end of the harvest. A `pago` that stayed queued
 * would hold the chip's «sin enviar» count above zero permanently, which is
 * the number the dueño checks before walking away from the lote.
 */
test("a rejected pago does not sit there retrying for ever", async () => {
  const { repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({ name: "L", type: "cafe", variety: "C", dimension: 1 })
    .lastInsertRowId;
  repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 50,
    date: "2026-08-24T14:00:00.000Z",
  });
  repo.payments.settle(person, "2026-08-24", "2026-08-30", 800);
  repo.payments.pay(person, 40_000_00, { method: "efectivo" });

  const { transport } = fakeApi();
  await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();
  assert.equal(repo.sync.pendingCount(), 0, "the outbox ends up empty, not stuck");

  // A second pass finds nothing to send and raises nothing new: the card is
  // upserted on (kind, entity, entityUuid), so it does not multiply either.
  const after = repo.sync.conflicts().length;
  await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();
  assert.equal(repo.sync.pendingCount(), 0);
  assert.equal(repo.sync.conflicts().length, after, "not one new card per pass");
});

/**
 * §7.3: a card about money names a person, a day and an amount.
 *
 * The card the farm saw for a Saturday's payroll said «un lote o un precio
 * hecho en el teléfono», sixty times, naming nobody — it shared a branch with
 * decision 6's plots and prices. It was wrong in every word that mattered.
 */
test("the card for money that stays behind names the person, the day and the amount", async () => {
  const { repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({ name: "L", type: "cafe", variety: "C", dimension: 1 })
    .lastInsertRowId;
  repo.pickups.add({
    personId: person,
    cropId: plot,
    weight: 50,
    date: "2026-08-24T14:00:00.000Z",
  });
  repo.payments.settle(person, "2026-08-24", "2026-08-30", 800);
  repo.payments.pay(person, 40_000_00, { method: "efectivo" });

  const { transport } = fakeApi();
  await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  const cards = repo.sync.conflicts().filter((c) => c.kind === "money-stays-here");
  assert.ok(cards.length >= 2, "the devengo and the pago");
  for (const c of cards) {
    assert.equal(c.personId, person, "the card knows who it is talking about");
    assert.equal(c.payload.person, "Ana R", "and it says so with their name");
    assert.ok(c.payload.date, "and with the day");
    assert.ok(
      typeof c.payload.amountCents === "number" && c.payload.amountCents !== 0,
      "and with the amount",
    );
  }
  // The ledger rows are NOT on the plots-and-prices card any more. The
  // settlement rows still take that branch — they carry no person and no
  // amount to put on a card — but the card now says «una liquidación hecha en
  // este teléfono» rather than «un lote o un precio», which is the word that
  // was wrong.
  const readOnly = repo.sync.conflicts().filter((c) => c.kind === "read-only-on-phone");
  assert.ok(
    readOnly.some((c) => c.payload.table === "settlements"),
    "the settlement does raise its own",
  );
  // The lote in this fixture legitimately raises decision 6's card. What must
  // never appear there again is a row of the ledger.
  assert.ok(
    !readOnly.some((c) => c.payload.table === "ledger"),
    "no movement of money ever lands on the plots-and-prices card again",
  );
});

test("one rejected envelope does not drag the others down", async () => {
  const { db, repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  const plot = repo.crops.add({ name: "L", type: "cafe", variety: "C", dimension: 1 })
    .lastInsertRowId;
  for (let i = 0; i < 5; i++)
    repo.pickups.add({
      personId: person,
      cropId: plot,
      weight: 40 + i,
      date: new Date(Date.UTC(2026, 7, 24, 12 + i)).toISOString(),
    });
  const doomed = uuidOf(db, "pickups", 3);

  const { transport } = fakeApi({
    rejectId: {
      id: doomed,
      code: "WORK_RECORD_SETTLED",
      message: "that record is inside a live settlement",
    },
  });
  const report = await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  // Four weighings and the worker all landed; the refused one raised a card,
  // and so did the lote — a lote created on the phone is read-only under
  // decision 6, and it is refused with its reason rather than dropped.
  assert.equal(repo.sync.pendingCount(), 0, "nothing was left stuck behind it");
  const cards = repo.sync.conflicts();
  assert.equal(report.conflicts, cards.length);

  const settled = cards.find((c) => c.kind === "pickup-already-settled")!;
  assert.ok(settled, "the refused weighing is in front of a person");
  assert.equal(settled.entityUuid, doomed);
  assert.equal(settled.payload.person, "Ana R", "§7.3: a card without a name is not a card");
  assert.ok(cards.some((c) => c.kind === "read-only-on-phone"));

  // The four that were accepted are gone from the queue and NOT in a card.
  assert.ok(!cards.some((c) => c.entity === "pickups" && c.entityUuid !== doomed));
});

// ---- The pull ----------------------------------------------------------

test("what comes down the feed is applied under the names the phone uses", async () => {
  const { db, repo } = aPhone();
  const workerId = "0198f3e1-0001-7000-8000-000000000001";
  const cropId = "0198f3e1-0002-7000-8000-000000000002";
  const recordId = "0198f3e1-0003-7000-8000-000000000003";
  const settlementId = "0198f3e1-0004-7000-8000-000000000004";
  const ledgerId = "0198f3e1-0005-7000-8000-000000000005";

  const { transport } = fakeApi({
    cursor: 3100,
    changes: [
      {
        seq: 3001,
        entity: "worker",
        op: "upsert",
        row: {
          id: workerId,
          name: "Marta",
          lastName: "Gómez",
          tag: "9",
          documentType: "CC",
          docId: "555",
          deletedAt: null,
        },
      },
      // The feed's `crop` IS the phone's lote, and the name it carries is the
      // PLOT's — which is the word the person at the scale has in their head.
      {
        seq: 3002,
        entity: "crop",
        op: "upsert",
        row: {
          id: cropId,
          plotId: "0198f3e1-00aa-7000-8000-0000000000aa",
          name: "La Cuchilla",
          cropType: "Café",
          variety: "Castillo",
          deletedAt: null,
        },
      },
      // A plot rename on the web. The phone has no plots table; it is dropped
      // and reported rather than silently swallowed.
      {
        seq: 3003,
        entity: "plot",
        op: "upsert",
        row: { id: "0198f3e1-00aa-7000-8000-0000000000aa", name: "La Cuchilla Alta" },
      },
      { seq: 3004, entity: "weekPrice", op: "upsert", row: { weekStart: "2026-08-24", priceCents: 85000 } },
      {
        seq: 3005,
        entity: "workRecord",
        op: "upsert",
        row: {
          id: recordId,
          workerId,
          cropId,
          // A decimal STRING, which is how the server sends a quantity so that
          // binary rounding never touches a kilo on the way through JSON.
          quantity: "37.500",
          occurredAt: "2026-08-25T14:05:00Z",
          localDay: "2026-08-25",
          weekStart: "2026-08-24",
          note: null,
          deviceId: null,
          deletedAt: null,
        },
      },
      {
        seq: 3006,
        entity: "settlement",
        op: "upsert",
        row: {
          id: settlementId,
          workerId,
          periodStart: "2026-08-24",
          periodEnd: "2026-08-30",
          grossCents: 3187500,
          status: "open",
          note: null,
          createdAt: "2026-08-30T22:00:00Z",
          voidedAt: null,
          items: [
            {
              payableId: recordId,
              weekStart: "2026-08-24",
              quantity: "37.500",
              priceCents: 85000,
              amountCents: 3187500,
              voided: false,
            },
          ],
        },
      },
      {
        seq: 3007,
        entity: "ledgerEntry",
        op: "append",
        row: {
          id: ledgerId,
          workerId,
          kind: "devengo",
          amountCents: 3187500,
          date: "2026-08-30",
          settlementId,
          method: null,
          note: null,
          reversesId: null,
          createdAt: "2026-08-30T22:00:00Z",
        },
      },
    ],
    balances: [{ workerId, balanceCents: 3187500 }],
  });

  const report = await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();
  assert.equal(report.ok, true, report.error?.message ?? "");

  // The lote wears the plot's name.
  const crop = db.prepare("SELECT * FROM crops WHERE uuid = ?").get(cropId) as {
    name: string;
    type: string;
  };
  assert.equal(crop.name, "La Cuchilla");

  // The weighing landed with the farm's day derived from the farm's zone, not
  // from the string the server sent: 14:05 UTC is the 25th in Bogotá.
  const pickup = db.prepare("SELECT * FROM pickups WHERE uuid = ?").get(recordId) as {
    weight: number;
    localDay: string;
    week: string;
  };
  assert.equal(pickup.weight, 37.5);
  assert.equal(pickup.localDay, "2026-08-25");
  assert.equal(pickup.week, "2026-08-24");

  // The settlement arrived whole, and its line points at the same weighing it
  // pointed at on the server. §1.4: the money is not remapped.
  const line = db
    .prepare(
      `SELECT si.amountCents, pk.uuid AS payable FROM settlement_items si
         JOIN pickups pk ON pk.id = si.pickupId`,
    )
    .get() as { amountCents: number; payable: string };
  assert.equal(line.payable, recordId);
  assert.equal(line.amountCents, 3187500);

  // The price came down as integer cents and nothing derived it from a float.
  const price = db
    .prepare("SELECT costPerUnitCents FROM cost_overrides WHERE week = ?")
    .get("2026-08-24") as { costPerUnitCents: number };
  assert.equal(price.costPerUnitCents, 85000);

  // The balance the phone derives matches the checksum, so no card was raised.
  assert.equal(report.mismatched, 0);
  assert.equal(repo.sync.openConflictCount(), 0);
  assert.equal(repo.sync.state().cursor, "3100");

  // And what could not be applied is named rather than swallowed.
  assert.ok(report.skipped.some((s) => /lote/.test(s.what)));
});

test("a balance that does not add up raises a card and does not copy the number", async () => {
  const { db, repo } = aPhone();
  const person = repo.people.add({
    name: "Ana",
    lastName: "R",
    documentType: "CC",
    docId: "1",
    tag: "1",
    image: "",
  }).lastInsertRowId;
  repo.payments.advance(person, 10_000_00, "anticipo");
  const workerId = uuidOf(db, "people", person);

  const { transport } = fakeApi({
    balances: [{ workerId, balanceCents: -999_999 }],
  });
  const report = await new SyncEngine({ repo, transport, random: () => 0.5 }).sync();

  assert.equal(report.mismatched, 1);
  const card = repo.sync.conflicts().find((c) => c.kind === "balance-mismatch")!;
  assert.equal(card.payload.localCents, -10_000_00);
  assert.equal(card.payload.serverCents, -999_999);
  // §7.4: the number that came down the wire is compared and thrown away.
  assert.equal(repo.payments.balance(person).balanceCents, -10_000_00);
});

test("applying the same batch of changes twice duplicates nothing", async () => {
  // The feed is ordered and the cursor never steps over a change, but a run
  // cut between applying and advancing repeats the batch — so the property the
  // whole design rests on is that repeating is a no-op.
  const workerId = "0198f3e1-0001-7000-8000-000000000001";
  const recordId = "0198f3e1-0003-7000-8000-000000000003";
  const changes = [
    {
      seq: 1,
      entity: "worker",
      op: "upsert",
      row: { id: workerId, name: "Marta", lastName: "Gómez", tag: "9", deletedAt: null },
    },
    {
      seq: 2,
      entity: "workRecord",
      op: "upsert",
      row: {
        id: recordId,
        workerId,
        cropId: null,
        quantity: "12.5",
        occurredAt: "2026-08-25T14:05:00Z",
        note: null,
        deletedAt: null,
      },
    },
  ];

  const { db, repo } = aPhone();
  const first = fakeApi({ changes });
  await new SyncEngine({ repo, transport: first.transport, random: () => 0.5 }).sync();
  const second = fakeApi({ changes });
  await new SyncEngine({ repo, transport: second.transport, random: () => 0.5 }).sync({
    force: true,
  });

  const n = (t: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  assert.equal(n("people"), 1);
  assert.equal(n("pickups"), 1);
  // And nothing the server sent was queued straight back at it.
  assert.equal(repo.sync.pendingCount(), 0);
});
