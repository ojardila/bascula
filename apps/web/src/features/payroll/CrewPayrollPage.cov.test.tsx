// SPDX-License-Identifier: MIT
/**
 * Crew payroll, the corners the other two files leave out: teams and accounts
 * with no basket number, a labor paid by something other than weight, a
 * re-read that fails halfway through the check, a run that blows up for a
 * reason that is not a refusal, an undo that cannot even start, a retry with
 * nobody ticked, and the paper when the farm has no name on file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { CrewPayrollPage } from "./CrewPayrollPage";
import * as crew from "./crew";
import { printDocument } from "../documents/print";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";

// jsdom cannot print; here the browser accepts the frame.
vi.mock("../documents/print", () => ({ printDocument: vi.fn(() => true) }));

// The real crew logic, with the three writers wrapped so one test can make
// them fail in a way the server never answers with.
vi.mock("./crew", async (importOriginal) => {
  const real = await importOriginal<typeof import("./crew")>();
  return {
    ...real,
    runSettlements: vi.fn(real.runSettlements),
    runPayments: vi.fn(real.runPayments),
    undoRun: vi.fn(real.undoRun),
  };
});

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";

const tenant = () => db.tenantOf(db.FARM_ID)!;

function renderPayroll() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/nomina"]}>
        <AuthProvider>
          <Routes>
            <Route path="/nomina" element={<CrewPayrollPage />} />
            <Route
              path="/empleados/:id/pagar"
              element={<div>pago de una persona</div>}
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  vi.mocked(printDocument).mockClear();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function openSettleConfirm(user: User) {
  await screen.findByText("1 · Liquidar la semana");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Revisar y liquidar · \$[1-9]/ }),
    ).toBeEnabled(),
  );
  await waitFor(
    async () => {
      if (!screen.queryByRole("dialog")) {
        await user.click(
          screen.getByRole("button", { name: /Revisar y liquidar/ }),
        );
      }
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 15000 },
  );
  return screen.getByRole("dialog");
}

async function openPayConfirm(user: User) {
  await screen.findByText("2 · Pagar la nómina");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Revisar y pagar · \$334\.500/ }),
    ).toBeEnabled(),
  );
  await waitFor(
    async () => {
      if (!screen.queryByRole("dialog")) {
        await user.click(
          screen.getByRole("button", { name: /Revisar y pagar/ }),
        );
      }
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 15000 },
  );
  return screen.getByRole("dialog");
}

async function dialogGone() {
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
}

describe("teams and accounts without a basket number", () => {
  it("counts accounts and people apart, searches without a tag, and opens the single-person payment", async () => {
    const t = tenant();
    const maria = t.workers.find((w) => w.id === MARIA)!;
    const jhon = t.workers.find((w) => w.id === JHON)!;
    // María's account is a team of two; Jhon Fredy's is a team with no member
    // list on the wire, which still counts as one head.
    maria.kind = "equipo";
    maria.tag = null;
    maria.members = [
      { id: "m-1", name: "Ana", lastName: "Uno", tag: null, from: "2026-01-01", to: null },
      { id: "m-2", name: "Beto", lastName: "Dos", tag: null, from: "2026-01-01", to: null },
    ];
    jhon.kind = "equipo";
    delete jhon.members;

    const user = userEvent.setup();
    renderPayroll();
    expect(
      (
        await screen.findAllByText(/\d+ cuentas · \d+ personas/, {}, { timeout: 15000 })
      ).length,
    ).toBeGreaterThan(0);

    // A search that matches no name has to look at the basket number, and
    // María's account has none.
    const box = screen.getByLabelText("Buscar por nombre o canasto");
    await user.type(box, "zzz");
    expect(
      await screen.findAllByText("Nadie coincide con el filtro."),
    ).toHaveLength(2);
    await user.clear(box);

    // Unticking and ticking again puts the person back in the run.
    const luz = "Incluir a Luz Dary Ospina Giraldo";
    const before = screen.getByRole("button", { name: /Revisar y liquidar/ })
      .textContent;
    await user.click(await screen.findByLabelText(luz));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Revisar y liquidar/ }).textContent,
      ).not.toBe(before),
    );
    await user.click(screen.getByLabelText(luz));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Revisar y liquidar/ }).textContent,
      ).toBe(before),
    );

    // The detail of one person offers to pay them on their own.
    await user.click(
      screen.getByRole("button", { name: "Ver el detalle de Luz Dary Ospina Giraldo" }),
    );
    await user.click(await screen.findByRole("button", { name: "Pagarle aparte" }));
    expect(await screen.findByText("pago de una persona")).toBeInTheDocument();
  }, 60000);
});

describe("a labor that is not paid by weight", () => {
  it("shows a dash instead of a quantity in the confirmation", async () => {
    for (const r of tenant().workRecords) {
      if (r.workerId === LUZ) r.unitId = null;
    }
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    const row = within(dialog)
      .getByText("Luz Dary Ospina Giraldo")
      .closest("tr") as HTMLElement;
    expect(within(row).getByText("—")).toBeInTheDocument();
  }, 60000);
});

describe("when the re-read fails", () => {
  it("stops the settlement for one unreadable person and says whose", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    server.use(
      http.get(`*/v1/workers/${MARIA}/payables`, () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    expect(
      await screen.findByText("Cambió algo mientras revisaba"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A una persona de la corrida le cambió la cifra/),
    ).toBeInTheDocument();
    const unreadable = screen
      .getByText("No se pudo volver a leer")
      .closest(".MuiAlert-root") as HTMLElement;
    expect(unreadable).toHaveTextContent("María Restrepo Ospina:");

    await user.click(screen.getByRole("button", { name: "Volver a revisar" }));
    await dialogGone();
    // The reload cannot read her either, and says so.
    expect(
      (await screen.findByText(/No entran en esta/)).closest(".MuiAlert-root"),
    ).toHaveTextContent("1 empleado");
  }, 60000);

  it("names every account it could not read, and can try again", async () => {
    const fail = () =>
      HttpResponse.json(
        { error: { code: "BAD_REQUEST", message: "bad" } },
        { status: 400 },
      );
    server.use(
      http.get(`*/v1/workers/${MARIA}/payables`, fail),
      http.get(`*/v1/workers/${JHON}/payables`, fail),
    );
    const user = userEvent.setup();
    renderPayroll();
    const warning = (await screen.findByText(/No entran en esta/)).closest(
      ".MuiAlert-root",
    ) as HTMLElement;
    expect(warning).toHaveTextContent("2 empleados");

    server.resetHandlers();
    await user.click(
      within(warning).getByRole("button", { name: "Volver a intentar" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/No entran en esta/)).not.toBeInTheDocument(),
    );
  }, 60000);

  it("stops the payment when the balances cannot be read again", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openPayConfirm(user);
    server.use(
      http.get("*/v1/balances", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "down" } },
          { status: 500 },
        ),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));

    expect(
      await screen.findByText("El saldo cambió mientras revisaba"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No se pudo volver a leer el saldo de/),
    ).toHaveTextContent("María Restrepo Ospina");

    await user.click(screen.getByRole("button", { name: "Volver a revisar" }));
    await dialogGone();
  }, 60000);
});

describe("work that lands during the check", () => {
  it("announces it, and the notice can be dismissed", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    const t = tenant();
    const source = t.workRecords.find((r) => r.workerId === MARIA)!;
    t.workRecords.push({
      ...source,
      id: "0192f3a0-0008-7000-8000-0000000000fe",
      quantity: 3,
      createdAt: "2026-08-28T22:00:00Z",
    });
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    const note = (
      await screen.findByText(/Llegó trabajo nuevo mientras revisaba/, {}, { timeout: 15000 })
    ).closest(".MuiAlert-root") as HTMLElement;
    await dialogGone();
    await user.click(within(note).getByRole("button", { name: /close|cerrar/i }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Llegó trabajo nuevo mientras revisaba/),
      ).not.toBeInTheDocument(),
    );
  }, 60000);
});

describe("failures that are not a refusal", () => {
  it("reports a settlement run that blew up", async () => {
    vi.mocked(crew.runSettlements).mockRejectedValueOnce(
      new Error("Se cortó la conexión"),
    );
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));
    expect(await screen.findByText("Se cortó la conexión")).toBeInTheDocument();
    expect(screen.queryByText("Liquidación de cuadrilla")).not.toBeInTheDocument();
  }, 60000);

  it("reports a payment run that blew up", async () => {
    vi.mocked(crew.runPayments).mockRejectedValueOnce(
      new Error("Se cortó la conexión"),
    );
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openPayConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
    expect(await screen.findByText("Se cortó la conexión")).toBeInTheDocument();
    expect(screen.queryByText("Nómina pagada")).not.toBeInTheDocument();
  }, 60000);

  it("reports an undo that could not start, after the dialog was dismissed once", async () => {
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openPayConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
    await screen.findByText("Nómina pagada", {}, { timeout: 15000 });
    await dialogGone();

    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await dialogGone();

    vi.mocked(crew.undoRun).mockRejectedValueOnce(new Error("No se pudo deshacer"));
    await user.click(screen.getByRole("button", { name: "Deshacer" }));
    const ask = await screen.findByRole("dialog");
    await user.click(within(ask).getByRole("button", { name: "Deshacer" }));
    expect(await screen.findByText("No se pudo deshacer")).toBeInTheDocument();
    // Nothing was undone, so the undo is still on offer.
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeInTheDocument();
  }, 60000);
});

describe("Reintentar with nobody ticked", () => {
  it("does not send anything for a settlement run", async () => {
    let seen = 0;
    server.use(
      http.post("*/v1/settlements", () => {
        seen++;
        if (seen !== 2) return undefined;
        return HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "no" } },
          { status: 400 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));
    expect(
      await screen.findByText("La corrida se detuvo", {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    await dialogGone();

    for (const box of screen.getAllByRole("checkbox", { name: /^Incluir a / })) {
      if ((box as HTMLInputElement).checked) await user.click(box);
    }
    const sent = seen;
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(screen.getByText("La corrida se detuvo")).toBeInTheDocument();
    expect(seen).toBe(sent);
  }, 60000);

  it("does not send anything for a payment run", async () => {
    let seen = 0;
    server.use(
      http.post("*/v1/payments", () => {
        seen++;
        if (seen !== 2) return undefined;
        return HttpResponse.json(
          { error: { code: "AMOUNT_EXCEEDS_BALANCE", message: "no" } },
          { status: 409 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openPayConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
    expect(
      await screen.findByText("La corrida se detuvo", {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    await dialogGone();

    for (const box of screen.getAllByRole("checkbox", { name: /^Pagar a / })) {
      if ((box as HTMLInputElement).checked) await user.click(box);
    }
    const sent = seen;
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(screen.getByText("La corrida se detuvo")).toBeInTheDocument();
    expect(seen).toBe(sent);
  }, 60000);
});

describe("the paper", () => {
  it("prints with a stand-in farm name, and counts a figure the server left out as zero", async () => {
    // A session whose farm came back without a name or a timezone.
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: OWNER,
          email: "owner@example.com",
          name: "Dueño",
          role: "owner",
          farm: { id: db.FARM_ID, name: null, timezone: null, currency: "COP", slug: "" },
          superadmin: false,
        }),
      ),
      // …and settlements answered without their gross.
      http.post("*/v1/settlements", () =>
        HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPayroll();
    const dialog = await openSettleConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));
    const title = await screen.findByText(
      "Liquidación de cuadrilla",
      {},
      { timeout: 15000 },
    );
    await dialogGone();
    const report = title.closest(".MuiCard-root") as HTMLElement;
    expect(within(report).getAllByText("$0").length).toBeGreaterThan(0);

    await user.click(within(report).getByRole("button", { name: /^Planilla/ }));
    expect(printDocument).toHaveBeenCalledTimes(1);
    expect(vi.mocked(printDocument).mock.calls[0][0]).toContain("Finca");
    expect(
      screen.queryByText(/No se pudo abrir la impresión/),
    ).not.toBeInTheDocument();
  }, 60000);
});
