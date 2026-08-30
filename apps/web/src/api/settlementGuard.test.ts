/**
 * CAN A STALE APPROVAL EVER REACH `POST /v1/settlements`?
 *
 * `expectedGrossCents` is required by the server, so the refusal itself is
 * not this file's to prove — the Go suite does that. What IS this file's to
 * prove is everything around it:
 *
 *   - the settlement WROTE NOTHING. Asserted on the ledger, not on the error
 *     code, because a guard that refuses after writing would still produce the
 *     right code and the wrong balance.
 *   - the refusal arrives carrying its explanation, joined from the server's
 *     `details` and the lines the screen was holding.
 *   - there is no path from a refusal back to a write without re-approving.
 *     `api.settle` takes the approved figure as an argument and has no retry
 *     of its own, so "re-approving" means a caller passing a different number
 *     — which is what the screen's "Volver a revisar" produces after
 *     reloading.
 *   - and the two ways to reach the server WITHOUT an approval are refused
 *     before the network: no figure, and no named set of payables.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { server } from "../mocks/node";
import * as db from "../mocks/db";
import { api, grossChangeOf } from "./endpoints";
import { setTokens } from "./client";
import { invalidateRefs } from "./refs";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
/** María has three unsettled payables in the seeded farm — $153.600 of them. */
const WORKER = "0192f3a0-0006-7000-8000-000000000001";

function signIn() {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: "mock-refresh",
  });
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn();
});

/**
 * How many settlements this worker has. The seeded farm already has movements
 * for María, so every "nothing was written" assertion is a delta on this and
 * not a claim that the ledger is empty.
 */
async function accruals(): Promise<number> {
  const ledger = await api.workerLedger(WORKER);
  return ledger.filter((e) => e.kind === "devengo").length;
}

/** Counts the settlement writes that actually left the client. */
function countSettlementPosts(): { n: () => number } {
  let n = 0;
  server.events.on("request:start", ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/settlements") n++;
  });
  return { n: () => n };
}

describe("the settlement lock", () => {
  it("settles when the approved figure is still the figure", async () => {
    const approved = await api.previewSettlement(WORKER);
    expect(approved.grossCents).toBeGreaterThan(0);

    const settlement = await api.settle(
      WORKER,
      approved.lines.map((l) => l.id),
      { expectedGrossCents: approved.grossCents, expectedLines: approved.lines },
    );
    expect(settlement.grossCents).toBe(approved.grossCents);
  });

  /* -- the server checks --------------------------------------------- */

  it("a server that checks answers 409 and writes nothing", async () => {
    const posts = countSettlementPosts();
    const before = await accruals();
    const earnedBefore = (await api.workerBalance(WORKER)).earnedCents;
    const approved = await api.previewSettlement(WORKER);

    // One peso less than the truth: the shape of "somebody changed the week's
    // price while this screen was open".
    const stale = approved.grossCents - 100;
    const refusal = await api
      .settle(
        WORKER,
        approved.lines.map((l) => l.id),
        { expectedGrossCents: stale, expectedLines: approved.lines },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(refusal).toMatchObject({ code: "GROSS_CHANGED", status: 409 });
    // The POST went out — that is how the server checked — but it wrote
    // nothing, which the ledger is the witness to. The seeded farm already has
    // movements for this worker, so the assertion is on the DELTA: a
    // settlement writes exactly one `devengo`, and there is no new one.
    expect(posts.n()).toBe(1);
    expect(await accruals()).toBe(before);
    expect((await api.workerBalance(WORKER)).earnedCents).toBe(earnedBefore);
  });

  it("and the refusal carries both figures and the reason", async () => {
    const approved = await api.previewSettlement(WORKER);
    const ids = approved.lines.map((l) => l.id);
    const gone = approved.lines[0];

    // One of the approved payables is taken away after the screen read it —
    // deactivated here, but on a farm this is somebody else's settlement
    // getting to it first. The figure is now short by exactly that line.
    const t = db.tenantOf(db.FARM_ID)!;
    t.workRecords.find((r) => r.id === gone.id)!.deletedAt = new Date().toISOString();

    const refusal = await api
      .settle(WORKER, ids, {
        expectedGrossCents: approved.grossCents,
        expectedLines: approved.lines,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    const change = grossChangeOf(refusal)!;
    expect(change).not.toBeNull();
    expect(change.beforeCents).toBe(approved.grossCents);
    expect(change.afterCents).toBe(approved.grossCents - gone.amountCents);
    expect(change.removedIds).toContain(gone.id);
    // Resolved against the lines the screen was holding, so the row can be
    // named on the dialog rather than shown as a UUID.
    expect(change.removed.map((l) => l.id)).toContain(gone.id);
    expect(change.causeIsKnown).toBe(true);
    // And the week is NOT reported as repriced: its price did not move, even
    // though `weeksInSettlement` carried it — as it always does.
    expect(change.repriced).toEqual([]);
  });

  it("a late weigh-in does not get in: naming the set removes the race", async () => {
    const approved = await api.previewSettlement(WORKER);
    const ids = approved.lines.map((l) => l.id);

    // A weighing lands after the screen was read. Because the request NAMES
    // what was approved, this is not a conflict to report — it is simply not
    // in the settlement. The spec asks for exactly this: "Naming the set
    // removes the race entirely rather than reporting it."
    const t = db.tenantOf(db.FARM_ID)!;
    const template = t.workRecords.find((r) => r.workerId === WORKER)!;
    t.workRecords.push({ ...template, id: crypto.randomUUID(), quantity: 1 });

    const settlement = await api.settle(WORKER, ids, {
      expectedGrossCents: approved.grossCents,
      expectedLines: approved.lines,
    });
    expect(settlement.grossCents).toBe(approved.grossCents);

    // …and the late one is still pending, for the next settlement.
    const left = await api.previewSettlement(WORKER);
    expect(left.lines).toHaveLength(1);
  });

  /* -- no way round it ----------------------------------------------- */

  it("there is no way to settle without saying which figure was approved", async () => {
    const approved = await api.previewSettlement(WORKER);
    await expect(
      // The shape a "reintentar" button would have to produce to skip the
      // check. It is refused before the network, as a programming error.
      api.settle(WORKER, approved.lines.map((l) => l.id), {
        expectedGrossCents: undefined as unknown as number,
      }),
    ).rejects.toThrow(/expectedGrossCents/);

    await expect(
      api.createPayment({
        id: crypto.randomUUID(),
        workerId: WORKER,
        amountCents: 1000,
        method: "efectivo",
        payableIds: approved.lines.map((l) => l.id),
      }),
    ).rejects.toThrow(/expectedGrossCents/);
  });

  it("paying settles first, and a stale figure pays nothing", async () => {
    const posts = countSettlementPosts();
    const before = await accruals();
    const paymentsBefore = (await api.workerLedger(WORKER)).filter(
      (e) => e.kind === "pago",
    ).length;
    const approved = await api.previewSettlement(WORKER);

    await expect(
      api.createPayment({
        id: crypto.randomUUID(),
        workerId: WORKER,
        amountCents: approved.grossCents,
        method: "efectivo",
        payableIds: approved.lines.map((l) => l.id),
        expectedGrossCents: approved.grossCents - 100,
        expectedLines: approved.lines,
      }),
    ).rejects.toMatchObject({ code: "GROSS_CHANGED" });

    expect(posts.n()).toBe(1);
    // Neither the settlement nor the payment landed. Both are asserted: a
    // guard that refused the settlement and paid anyway would post money
    // against a balance that does not include the work.
    expect(await accruals()).toBe(before);
    const after = await api.workerLedger(WORKER);
    expect(after.filter((e) => e.kind === "pago")).toHaveLength(paymentsBefore);
  });
});
