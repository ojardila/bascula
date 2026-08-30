/**
 * CREW PAYROLL, END TO END.
 *
 * `crew.test.ts` exercises the rules over plain numbers. This exercises the
 * other thing, which is what actually gets signed on a Saturday: the screen,
 * the approval, the writes against the mock server and the ledger left behind.
 * Nothing is stubbed out in the client layer — what is exercised is the whole
 * path, just as in `PayWorkerPage.test.tsx`.
 *
 * The seeded farm has three people with outstanding work (María $153.600, Luz
 * Dary $49.000, Jhon Fredy $41.840) and a fourth, Édinson, already settled and
 * unpaid, with a $150.000 balance. That fourth person is not scenery: he is
 * the half-done state the screen has to be able to read back off the server
 * without ever having stored it anywhere.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { CrewPayrollPage } from "./CrewPayrollPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { http, HttpResponse } from "msw";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderPayroll() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/nomina"]}>
        <AuthProvider>
          <CrewPayrollPage />
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

/** The owner raises the week's price from the phone, in the next room. */
function repriceWeek(monday: string, priceCents: number) {
  const t = db.tenantOf(db.FARM_ID)!;
  const existing = t.weekPrices.find((p) => p.weekStart === monday);
  if (existing) existing.priceCents = priceCents;
  else t.weekPrices.push({ weekStart: monday, priceCents });
}

const tenant = () => db.tenantOf(db.FARM_ID)!;
const liveSettlements = () => tenant().settlements.filter((s) => s.status === "open");
const payments = () => tenant().ledger.filter((e) => e.kind === "pago");
const paidOut = () => payments().reduce((a, e) => a + Math.abs(e.amountCents), 0);

/** Open step 1's confirmation dialog and stay inside it. */
async function openSettleConfirm(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("1 · Liquidar la semana");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Revisar y liquidar/ })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: /Revisar y liquidar/ }));
  return screen.findByRole("dialog");
}

/* ------------------------------------------------------------------ */

describe("see it before you sign it", () => {
  it("shows who is getting paid, how much, why, and the farm's total", async () => {
    const user = userEvent.setup();
    renderPayroll();

    await screen.findByText("1 · Liquidar la semana");
    // The crew's total: 153.600 + 49.000 + 41.840.
    expect(await screen.findByText("$244.440")).toBeInTheDocument();
    expect(screen.getByText(/3 personas/)).toBeInTheDocument();

    // And the WHY, which is what the phone never showed: kilos and price, line
    // by line, without leaving the screen.
    await user.click(screen.getByRole("button", { name: /Ver el detalle de María/ }));
    // Her two weigh-ins go at the week's price; the strimming carries its own.
    expect(await screen.findAllByText("$800 / kg")).toHaveLength(2);
    expect(screen.getByText("38,5 kg")).toBeInTheDocument();
    expect(screen.getByText("$45.000")).toBeInTheDocument();
  }, 30000);

  /**
   * The half-done state the two-step design creates — and which is only
   * acceptable because it is not stored: it is derived. Édinson has been
   * settled and unpaid since before this screen existed, and he shows up on
   * his own.
   */
  it("step 2 rebuilds from the server whoever was left settled and unpaid", async () => {
    renderPayroll();
    const step2 = (await screen.findByText("2 · Pagar la nómina")).closest(".MuiCard-root")!;
    await waitFor(() =>
      expect(within(step2 as HTMLElement).getByText("Édinson Marín Ríos")).toBeInTheDocument(),
    );
    // Édinson's $150.000 + María's $184.500.
    expect(within(step2 as HTMLElement).getByText("$334.500")).toBeInTheDocument();
  }, 30000);

  it("the dialog lists everybody again with their amount before signing", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    expect(within(dialog).getByText("Liquidar a 3 personas")).toBeInTheDocument();
    for (const name of ["María Restrepo Ospina", "Jhon Fredy Cardona Loaiza", "Luz Dary Ospina Giraldo"]) {
      expect(within(dialog).getByText(name)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("$153.600")).toBeInTheDocument();
    expect(within(dialog).getByText("$244.440")).toBeInTheDocument();
    // And it says what it does NOT do, which is half the value of the split.
    expect(within(dialog).getByText(/No entrega plata todavía/)).toBeInTheDocument();
  }, 30000);
});

/* ------------------------------------------------------------------ */

describe("the race guard, applied to a group", () => {
  /**
   * ONE person's gross changed. NOBODY gets settled — not even the two whose
   * price did not move — and the screen says whose and what happened.
   */
  it("if one person's gross changed, nothing is written for anybody and it says whose", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    // …and now the owner raises the week from $800 to $840 a kilo. Only María
    // and Jhon Fredy have weigh-ins at the week's price.
    repriceWeek("2026-08-24", 84_000);

    const before = liveSettlements().length;
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(await screen.findByText("Cambió algo mientras revisaba")).toBeInTheDocument();
    expect(
      await screen.findByText(/No se liquidó a nadie, y no se pagó a nadie/),
    ).toBeInTheDocument();

    // WHOSE, and WHAT changed — in the same sentence as the single-person
    // screen, so that there are never two wordings of the same fact.
    expect(
      await screen.findByText(
        /Cuando abrió esta pantalla eran \$153\.600; ahora son \$156\.780 porque el precio de la semana del 24 de agosto pasó de \$800 a \$840\./,
      ),
    ).toBeInTheDocument();

    // And not one settlement written: not María's, not Luz Dary's, whose
    // figures did not move at all. That is what "pay nobody" means.
    expect(liveSettlements().length).toBe(before);
  }, 30000);

  it("the only way out is to look again, never a retry", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    repriceWeek("2026-08-24", 84_000);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    const drift = await screen.findByText("Cambió algo mientras revisaba");
    const box = drift.closest('[role="dialog"]') as HTMLElement;
    expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Volver a revisar",
    ]);

    await user.click(within(box).getByRole("button", { name: "Volver a revisar" }));
    // And it comes back with the new figure, the one the next approval carries.
    expect(await screen.findByText("$249.712")).toBeInTheDocument();
  }, 30000);

  /**
   * THE HALF THAT DOES NOT BLOCK. A late weigh-in does not change the figure
   * being signed — the settlement names its own set — so the payroll goes
   * out, and the screen says that work is left for next time instead of
   * keeping quiet about it.
   */
  it("a weigh-in that lands late does not stop the payroll, but is announced", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    const t = tenant();
    const maria = t.workers[0];
    const source = t.workRecords[0];
    t.workRecords.push({
      ...source,
      id: "0192f3a0-0008-7000-8000-0000000000ff",
      workerId: maria.id,
      quantity: 9,
      estimatedAmountCents: 720_000,
      createdAt: "2026-08-28T22:00:00Z",
    });

    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(await screen.findByText("Liquidación de cuadrilla")).toBeInTheDocument();
    expect(liveSettlements().length).toBe(4);
    expect(await screen.findByText(/Llegó trabajo nuevo mientras revisaba/)).toBeInTheDocument();
    expect(screen.getByText(/No entra en esta corrida/)).toBeInTheDocument();
  }, 30000);

  /** The same idea over the other number: after settling, the balance. */
  it("if one person's balance changed, nobody gets paid", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("2 · Pagar la nómina");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const dialog = await screen.findByRole("dialog");

    // Somebody handed Édinson an advance out in the plot in the meantime.
    tenant().ledger.push({
      id: crypto.randomUUID(),
      workerId: tenant().workers[3].id,
      kind: "anticipo",
      amountCents: -5_000_000,
      date: "2026-08-29T12:00:00Z",
      settlementId: null,
      method: "efectivo",
      note: null,
      reversesId: null,
      createdAt: "2026-08-29T12:00:00Z",
    });

    const before = paidOut();
    await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));

    expect(await screen.findByText("El saldo cambió mientras revisaba")).toBeInTheDocument();
    expect(await screen.findByText(/No se pagó a nadie/)).toBeInTheDocument();
    expect(paidOut()).toBe(before);
  }, 30000);
});

/* ------------------------------------------------------------------ */

/**
 * ── THE DOUBLE CLICK, MULTIPLIED BY THIRTY ──────────────────────────────
 *
 * Finding A1 on the single-person screen cost $10.000 too much. The same bug
 * here costs a whole payroll run repeated. The clicks are dispatched natively,
 * in the same macrotask, which is the only thing that reproduces what a real
 * mouse does: `userEvent` waits between actions and `fireEvent` wraps each
 * call in `act()`, and both hand React a re-render in between that a real
 * double click never gives it.
 */
describe("a double click cannot fire the payroll twice", () => {
  it("settles once only, even with the pre-check running ahead of it", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);

    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/settlements") {
        posts.push(request.url);
      }
    });

    const button = within(dialog).getByRole("button", { name: "Liquidar" });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await screen.findByText("Liquidación de cuadrilla");
    // Three people, three settlements. Not six.
    expect(posts).toHaveLength(3);
    expect(liveSettlements().length).toBe(4);
  }, 30000);

  it("and pays once only", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("2 · Pagar la nómina");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const dialog = await screen.findByRole("dialog");

    // The seeded farm already has payments on it: what is measured is what
    // THIS run hands over, not the season's running total.
    const before = paidOut();
    const posts: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/payments") {
        posts.push(request.url);
      }
    });

    const button = within(dialog).getByRole("button", { name: /^Pagar \$/ });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await screen.findByText("Nómina pagada");
    expect(posts).toHaveLength(2);
    // Édinson's $150.000 + María's $184.500, once only.
    expect(paidOut() - before).toBe(33_450_000);
  }, 30000);
});

/* ------------------------------------------------------------------ */

describe("the complete run, and its report", () => {
  it("settles, then pays, and the report says how much each person got", async () => {
    const user = userEvent.setup();
    const before = paidOut();
    renderPayroll();

    const settle = await openSettleConfirm(user);
    await user.click(within(settle).getByRole("button", { name: "Liquidar" }));
    await screen.findByText("Liquidación de cuadrilla");
    expect(liveSettlements().length).toBe(4);

    // Now step 2 brings all four: the three just settled, and Édinson.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar · \$578\.940/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const pay = await screen.findByRole("dialog");
    await user.click(within(pay).getByRole("button", { name: /^Pagar \$578\.940$/ }));

    const report = await screen.findByText("Nómina pagada");
    const card = report.closest(".MuiCard-root") as HTMLElement;
    expect(within(card).getByText(/4 de 4 personas · \$578\.940/)).toBeInTheDocument();
    expect(paidOut() - before).toBe(57_894_000);
  }, 40000);

  /**
   * It stops at the first refusal, on purpose, and what did get in is left
   * written, counted and undoable. A report that said "it failed" without
   * saying who got in would leave somebody counting cash against nothing.
   */
  it("stops at the first refusal and says who got in and who did not", async () => {
    const user = userEvent.setup();
    // Only the SECOND write falls over. Returning `undefined` lets the request
    // through to the usual handler, so the first is really written and the
    // third is never attempted.
    let seen = 0;
    server.use(
      http.post("*/v1/settlements", () => {
        seen++;
        if (seen !== 2) return undefined;
        return HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 503 },
        );
      }),
    );

    renderPayroll();
    const dialog = await openSettleConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(await screen.findByText("La corrida se detuvo")).toBeInTheDocument();
    const report = (await screen.findByText("Liquidación de cuadrilla")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(within(report).getByText(/1 de 3 personas/)).toBeInTheDocument();
    expect(within(report).getByText("entró")).toBeInTheDocument();
    expect(within(report).getByText("no entró")).toBeInTheDocument();
    expect(within(report).getByText("sin intentar")).toBeInTheDocument();
    // And the paper will own up to it.
    expect(within(report).getByText(/PARCIAL/)).toBeInTheDocument();
  }, 40000);
});

/* ------------------------------------------------------------------ */

describe("undoing the payroll", () => {
  it("reverses the payments, voids the settlements and says what it undid", async () => {
    const user = userEvent.setup();
    const before = paidOut();
    const seededPayments = payments().length;
    renderPayroll();

    const settle = await openSettleConfirm(user);
    await user.click(within(settle).getByRole("button", { name: "Liquidar" }));
    await screen.findByText("Liquidación de cuadrilla");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y pagar · \$578\.940/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y pagar/ }));
    const pay = await screen.findByRole("dialog");
    await user.click(within(pay).getByRole("button", { name: /^Pagar \$578\.940$/ }));
    await screen.findByText("Nómina pagada");
    expect(paidOut() - before).toBe(57_894_000);

    // It says what it will undo BEFORE doing it. `findBy` and not `getBy`:
    // while the payment dialog is closing, MUI leaves the rest of the page
    // `aria-hidden` and role queries cannot see it.
    await user.click(await screen.findByRole("button", { name: "Deshacer" }));
    const askBox = await screen.findByRole("dialog");
    expect(askBox.textContent).toContain(
      "Se van a reversar 4 pagos y a anular 3 liquidaciones",
    );
    await user.click(within(askBox).getByRole("button", { name: "Deshacer" }));

    // And what it undid, afterwards.
    expect(await screen.findByText("Nómina deshecha")).toBeInTheDocument();
    // The three from this run end up voided. Édinson's, which already existed
    // beforehand and is not part of this payroll, still stands: undo undoes
    // WHAT THIS SCREEN WROTE and nothing else.
    await waitFor(() => expect(liveSettlements()).toHaveLength(1));

    // The ledger: every payment with its reversal, and not one row deleted.
    const ledger = tenant().ledger;
    const ours = ledger.filter((e) => e.kind === "pago").slice(seededPayments);
    expect(ours).toHaveLength(4);
    for (const p of ours) {
      expect(ledger.some((r) => r.reversesId === p.id)).toBe(true);
    }
  }, 60000);
});

/* ------------------------------------------------------------------ */

describe("the paper says whether it was filtered", () => {
  it("a run over a filter is marked partial and names the filter", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("1 · Liquidar la semana");

    await user.type(screen.getByLabelText("Buscar por empleado"), "María");
    expect(await screen.findByText(/no de la finca entera/)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y liquidar · \$153\.600/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y liquidar/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/la planilla saldrá marcada como parcial/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    const report = (await screen.findByText("Liquidación de cuadrilla")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(report.textContent).toContain("Planilla (parcial)");
    expect(within(report).getByText(/empleado contiene «María»/)).toBeInTheDocument();
    // And the other way of narrowing it, the one only this screen has.
    expect(within(report).getByText(/se dejó fuera a 2 personas/)).toBeInTheDocument();
  }, 40000);

  it("and unticking somebody makes the sheet partial too, with no filter at all", async () => {
    const user = userEvent.setup();
    renderPayroll();
    await screen.findByText("1 · Liquidar la semana");
    await user.click(await screen.findByLabelText("Incluir a Luz Dary Ospina Giraldo"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Revisar y liquidar · \$195\.440/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Revisar y liquidar/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Liquidar" }),
    );

    const report = (await screen.findByText("Liquidación de cuadrilla")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(within(report).getByText(/se dejó fuera a 1 persona/)).toBeInTheDocument();
  }, 40000);
});
