/**
 * THE DIFFERENCE SCREEN, from the outside.
 *
 * `api/settlementGuard.test.ts` proves the refusal cannot be got round at the
 * client layer. This file proves the other half, which is the half the owner
 * actually asked for: that when the refusal happens, the person is shown the
 * DIFFERENCE and not an error — and that the only way out of it goes back
 * through looking.
 *
 * The race is staged the way it happens on a farm: the screen loads and shows
 * a gross, and only then does the week's price move. Nothing is stubbed at the
 * client layer, so what is asserted is the whole path — the screen's captured
 * approval, `api.settle`'s guard, the mock's 409, and the dialog.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { PayWorkerPage } from "./PayWorkerPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { http, HttpResponse } from "msw";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
/** María: three unsettled payables in the seeded farm. */
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function renderPay() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/empleados/${MARIA}/pagar`]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/:id/pagar" element={<PayWorkerPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

/**
 * THE WEEK'S PRICE MOVES, after the screen has been read.
 *
 * This is the race that actually bites this screen, and it is worth being
 * precise about why. The payment screen sends the payables it TICKED, by id —
 * so a late pickup landing in the same period does not change what those ids
 * are worth; it just stays pending, which is safe.
 *
 * A weekly price is different. The seeded farm prices its picking by the week
 * (`rateSource: "weekly_price"`), which means those payables are NOT priced
 * until the settlement runs. Change the week's price and the very same ids are
 * suddenly worth something else — with no new row anywhere, and nothing on
 * this screen to hint at it. That is a signature on a figure nobody read.
 *
 * It is written straight into the store rather than through the API, because
 * that is what "the owner, on the phone, in the next room" looks like from
 * this browser's point of view.
 */
function repriceWeek(monday: string, priceCents: number) {
  const t = db.tenantOf(db.FARM_ID)!;
  const existing = t.weekPrices.find((p) => p.weekStart === monday);
  if (existing) existing.priceCents = priceCents;
  else t.weekPrices.push({ weekStart: monday, priceCents });
}

/**
 * ── PAYING IS NO LONGER ONE CLICK ────────────────────────────────────────
 *
 * Handing over $338.100 was a green button, irreversible and without asking,
 * while deactivating an employee —which can be undone— got a red dialog. Now
 * the button says "Revisar y pagar" and writes nothing: it opens the
 * confirmation listing the work items with their amounts, the same as crew
 * payroll. The button that writes is inside it, and these helpers are the
 * path anybody paying now walks.
 */
async function confirmDialog() {
  const title = await screen.findByText(/^Entregar \$/);
  return title.closest('[role="dialog"]') as HTMLElement;
}

/**
 * MUI leaves the dialog mounted —and `aria-modal`— for the 195 ms of the
 * closing animation, so without this the next query over the page sees
 * nothing: the modal on its way out is still covering the document.
 */
async function confirmDialogGone() {
  await waitFor(() =>
    expect(screen.queryByText(/^Entregar \$/)).not.toBeInTheDocument(),
  );
}

/** Review and sign the payment in full. */
async function payTotal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
  const dialog = await confirmDialog();
  await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
  await confirmDialogGone();
}

/** Review and sign a partial payment, the one in the box on the right. */
async function payPartial(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Revisar" }));
  const dialog = await confirmDialog();
  await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
  await confirmDialogGone();
}

/** The race dialog, found by its title rather than by being "the" dialog. */
async function driftDialog() {
  const title = await screen.findByText("El total cambió mientras revisaba");
  return title.closest('[role="dialog"]') as HTMLElement;
}

describe("when the gross changes between looking at it and approving it", () => {
  it("shows no error: it shows the difference and why", async () => {
    const user = userEvent.setup();
    renderPay();

    // The figure the person reads and is about to approve.
    await screen.findByText("Labores pendientes de liquidar");
    expect(await screen.findByText("$153.600")).toBeInTheDocument();

    // …and now the owner raises the week from $800 to $840 a kilo.
    repriceWeek("2026-08-24", 84_000);

    await payTotal(user);

    const dialog = await driftDialog();

    // The sentence the owner asked for, with both figures in it, the week
    // named, and the price it moved between. The arithmetic is the server's:
    // at $840 the total is $156.780 once each row is rounded on its own, not
    // the round $161.280 an eyeball would predict — the screen prints what the
    // settlement would write, never an estimate of it.
    expect(
      within(dialog).getByText(
        "Cuando abrió esta pantalla eran $153.600; ahora son $156.780 porque " +
          "el precio de la semana del 24 de agosto pasó de $800 a $840.",
      ),
    ).toBeInTheDocument();

    // And the reprice is spelled out again next to the rows, so the sentence
    // can be checked against something rather than believed.
    expect(
      within(dialog).getByText(/se pagan al precio de la semana, y ese precio cambió/),
    ).toBeInTheDocument();

    // And it says, in as many words, that nothing was written.
    expect(
      within(dialog).getByText(/No se registró ningún pago ni ninguna liquidación/),
    ).toBeInTheDocument();
  }, 20000);

  /**
   * The design decision this test exists to protect. A "reintentar" would
   * re-send the approval the person has already been told is stale — the whole
   * bug, behind one more click.
   */
  it("the only way out is to look again, never a retry", async () => {
    const user = userEvent.setup();
    renderPay();
    await screen.findByText("$153.600");
    repriceWeek("2026-08-24", 84_000);
    await payTotal(user);

    const dialog = await driftDialog();
    const buttons = within(dialog)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Volver a revisar"]);

    // Pressing it reloads what is owed and shows the NEW figure, which is the
    // one the next approval will carry.
    await user.click(within(dialog).getByRole("button", { name: "Volver a revisar" }));
    expect(await screen.findByText("$156.780")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }, 20000);

  it("and after looking again, the new figure can be approved", async () => {
    const user = userEvent.setup();
    renderPay();
    await screen.findByText("$153.600");
    repriceWeek("2026-08-24", 84_000);
    await payTotal(user);
    await user.click(
      within(await driftDialog()).getByRole("button", { name: "Volver a revisar" }),
    );
    await screen.findByText("$156.780");

    await payTotal(user);

    // The receipt, which is the proof the settlement and the payment both went
    // through at the figure that was actually approved.
    const receipt = (await screen.findByText("Pago registrado")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    expect(within(receipt).getByRole("button", { name: /Imprimir recibo/ })).toBeInTheDocument();
  }, 20000);
});

describe("a provisional figure is not shown as a final one", () => {
  it("flags the work items that are paid at the week's price", async () => {
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    // The seeded farm prices its picking by the week, so these rows are not
    // decided yet and the screen has to say so before somebody signs them.
    expect(screen.getAllByText("provisional").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/se pagan al precio de la semana, que se fija al cerrar la semana/),
    ).toBeInTheDocument();
  }, 20000);
});

/**
 * ── THE DOUBLE CLICK ─────────────────────────────────────────────────────
 *
 * The auditor's finding, staged the way it happened: two clicks, no wait
 * between them, on a payment against the BALANCE alone. That last part is the
 * whole shape of the bug. When work items are ticked, the settlement's
 * anti-double-pay lock catches the second attempt (201 then 409, one payment)
 * — so every test that existed passed while the common case, paying off a
 * balance, went through twice for double the money.
 *
 * THE CLICKS ARE DISPATCHED NATIVELY, and that is not fussiness. `userEvent`
 * awaits between actions and `fireEvent` wraps each call in `act()`; both give
 * React a re-render between the two clicks, which is exactly the thing a real
 * double click does not give it. Under either helper this screen looked fine
 * and `disabled={busy}` looked like a guard. Two `dispatchEvent` calls in one
 * synchronous block reproduce what the browser actually did — verified: the
 * handler ran twice with the button still enabled.
 */
describe("a double click cannot pay twice", () => {
  /** Untick every outstanding work item, leaving a payment against the pure balance. */
  async function payAgainstBalanceOnly(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText("Labores pendientes de liquidar");
    const boxes = screen
      .getAllByRole("checkbox")
      .filter((b) => (b as HTMLInputElement).checked);
    for (const box of boxes) await user.click(box);
    expect(screen.getByText("Labores seleccionadas").parentElement).toHaveTextContent("$0");
  }

  /** What the farm actually handed over, in cents, out of the ledger. */
  function paidOut() {
    return db
      .tenantOf(db.FARM_ID)!
      .ledger.filter((e) => e.kind === "pago")
      .reduce((a, e) => a + Math.abs(e.amountCents), 0);
  }

  it("records one payment and hands over the cash once", async () => {
    const user = userEvent.setup();
    renderPay();
    await payAgainstBalanceOnly(user);

    const before = paidOut();
    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/payments") {
        posts.push(request.url);
      }
    });

    /**
     * A PARTIAL payment, well under the balance, which is Ana Ramírez's case
     * exactly. Paying the whole balance would let the server's own
     * AMOUNT_EXCEEDS_BALANCE catch the second request by luck — and that luck
     * is why this never showed up as lost money in a test. Here both requests
     * would be perfectly payable, so nothing downstream saves us: the only
     * thing between $10.000 and $20.000 is the guard on this screen.
     */
    await user.type(screen.getByLabelText("Valor"), "10000");
    // The button that writes now lives inside the confirmation. The guard
    // under test —`useWriteOnce`'s synchronous ref— is still on the same
    // call, so the double click is fired where it really happens.
    await user.click(screen.getByRole("button", { name: "Revisar" }));
    const button = within(await confirmDialog()).getByRole("button", { name: /^Pagar \$/ });
    // Two events, one task. No await, no re-render in between — which is
    // precisely why `disabled={busy}` never saw the second one.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await screen.findByText("Pago registrado");
    // The receipt is the visible half; the ledger is the half that is money.
    expect(paidOut()).toBe(before + 1_000_000);
    expect(posts).toHaveLength(1);
  }, 20000);

  /**
   * And the other half: when a request DOES leave twice — a timeout the person
   * retries by hand — it carries the id it carried the first time, so the
   * server answers with the payment it already wrote. Minting the id inside
   * the call, which is what this app did, made every retry a new payment and
   * left the server's idempotency-by-id switched off.
   */
  it("the retry carries the same id, so the server's idempotency actually fires", async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    server.use(
      http.post("*/v1/payments", async ({ request }) => {
        const body = (await request.json()) as { id: string };
        ids.push(body.id);
        return HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 503 },
        );
      }),
    );

    renderPay();
    await payAgainstBalanceOnly(user);

    await payTotal(user);
    await waitFor(() => expect(ids).toHaveLength(1));
    await payTotal(user);
    await waitFor(() => expect(ids).toHaveLength(2));

    expect(ids[0]).toBe(ids[1]);
  }, 20000);

  /**
   * Correcting the amount, on the other hand, is a DIFFERENT fact. Reusing the
   * id there would be the same bug pointing the other way: the server would
   * answer the $12.000 request with the $10.000 payment it already has, and
   * the screen would print a receipt for money that was never handed over.
   */
  it("changing the amount really is a different payment", async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    server.use(
      http.post("*/v1/payments", async ({ request }) => {
        const body = (await request.json()) as { id: string };
        ids.push(body.id);
        return HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 503 },
        );
      }),
    );

    renderPay();
    await payAgainstBalanceOnly(user);

    const amount = screen.getByLabelText("Valor");
    await user.type(amount, "1000");
    await payPartial(user);
    await waitFor(() => expect(ids).toHaveLength(1));

    await user.clear(amount);
    await user.type(amount, "2000");
    await payPartial(user);
    await waitFor(() => expect(ids).toHaveLength(2));

    expect(ids[0]).not.toBe(ids[1]);
  }, 20000);
});

/**
 * ── ADVANCES, ON THE SIDE THEY ACTUALLY BELONG ───────────────────────────
 *
 * The "Deudas y anticipos" box painted `cents={-d.amountCents}`, so cash the
 * person had ALREADY RECEIVED came out as "+ $45.000" in green, with a plus
 * sign — while the same line, in the profile's history, came out in red with
 * a minus. Two screens, two signs, one single ledger entry. And since these
 * are entries already inside the balance, they went on looking identical
 * after everything was paid off and the balance was $0, reading as a debt the
 * payment had not cleared.
 */
describe("advances and deductions", () => {
  it("are shown as what they are: cash already handed over, negative", async () => {
    renderPay();
    const card = (await screen.findByText("Anticipos y deudas ya descontados")).closest(
      ".MuiCardContent-root",
    ) as HTMLElement;

    // María's seeded advance: $50.000 she has already received.
    expect(within(card).getByText("− $50.000")).toBeInTheDocument();
    expect(within(card).queryByText("+ $50.000")).not.toBeInTheDocument();
  }, 20000);

  it("says they are already subtracted from the balance, so they are not counted twice", async () => {
    renderPay();
    expect(
      await screen.findByText(/ya está restada del saldo/),
    ).toBeInTheDocument();
  }, 20000);
});
