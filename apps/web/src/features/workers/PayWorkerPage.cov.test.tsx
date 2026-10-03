// SPDX-License-Identifier: MIT
/**
 * The payment screen's remaining edges: dialogs closed with Escape, buttons
 * pressed while a dialog is on its way out, a receipt printed before the
 * signed-in user is known, a slip that lists deductions, a difference with
 * rows that came and went, a refusal that names no balance, and a team whose
 * member list is missing or changes under the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { delay, http, HttpResponse } from "msw";
import { PayWorkerPage } from "./PayWorkerPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { PayableLine, Payment, Worker } from "../../api/types";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const print = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../documents/print", () => ({
  printDocument: vi.fn((html: string) => {
    print.calls.push(html);
    return true;
  }),
}));

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";
const TEAM = "0192f3a0-0006-7000-8000-0000000000aa";

type User = ReturnType<typeof userEvent.setup>;

function renderPay(workerId = MARIA) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/empleados/${workerId}/pagar`]}>
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
  print.calls = [];
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const dialogTitled = async (title: string | RegExp) =>
  (await screen.findByText(title, undefined, { timeout: 15000 })).closest(
    '[role="dialog"]',
  ) as HTMLElement;

async function openConfirm(user: User, button: RegExp | string) {
  await user.click(
    await screen.findByRole(
      "button",
      { name: button },
      { timeout: 15000 },
    ),
  );
  return dialogTitled(/^Entregar \$/);
}

async function payTotal(user: User) {
  const dialog = await openConfirm(user, /Revisar y pagar/);
  await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
}

const line = (id: string, activityName: string, amountCents: number): PayableLine => ({
  id,
  activityName,
  dateFrom: "2026-08-24",
  dateTo: "2026-08-24",
  weekStart: "2026-08-24",
  plotNames: [],
  quantity: 10,
  unitLabel: "kg",
  rateCents: 80_000,
  rateSource: "weekly_price",
  amountCents,
});

const fakePayment = (workerId: string, amountCents: number): Payment => ({
  id: "0192f3a0-00ff-7000-8000-000000000001",
  workerId,
  amountCents,
  method: "efectivo",
  receiptNumber: "AB12-CD34",
  balanceBeforeCents: amountCents,
  balanceAfterCents: 0,
  date: "2026-08-30",
});

describe("closing dialogs with Escape", () => {
  it("closes the confirmation without paying", async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(api, "createPayment");
    renderPay();
    await openConfirm(user, /Revisar y pagar/);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText(/^Entregar \$/)).not.toBeInTheDocument(),
    );
    expect(create).not.toHaveBeenCalled();
  }, 30000);

  it("closes the receipt", async () => {
    const user = userEvent.setup();
    renderPay();
    await payTotal(user);
    await dialogTitled("Pago registrado");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("Pago registrado")).not.toBeInTheDocument(),
    );
  }, 30000);

  it("does not print or share a receipt that was just dismissed", async () => {
    // While the dialog fades out its print and WhatsApp buttons are still on
    // the page; pressing them must not act on a receipt that is gone.
    const user = userEvent.setup();
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    renderPay();
    await payTotal(user);
    const receipt = await dialogTitled("Pago registrado");
    const printBtn = within(receipt).getByRole("button", { name: /Imprimir recibo/ });
    const shareBtn = within(receipt).getByRole("button", { name: /Enviar por WhatsApp/ });
    fireEvent.click(within(receipt).getByRole("button", { name: "Seguir aquí" }));
    fireEvent.click(printBtn);
    fireEvent.click(shareBtn);
    await waitFor(() =>
      expect(screen.queryByText("Pago registrado")).not.toBeInTheDocument(),
    );
    expect(print.calls).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
  }, 30000);
});

describe("the receipt before the user is known", () => {
  it("prints and shares it under a generic farm name, without the slip", async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    server.use(
      http.get("*/v1/me", async () => {
        await delay("infinite");
        return HttpResponse.json({});
      }),
      http.get("*/v1/payments/:id", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom", details: {} } },
          { status: 500 },
        ),
      ),
    );
    renderPay();
    await payTotal(user);
    const receipt = await dialogTitled("Pago registrado");
    await user.click(within(receipt).getByRole("button", { name: /Imprimir recibo/ }));
    expect(print.calls).toHaveLength(1);
    expect(print.calls[0]).toContain("Finca");
    await user.click(
      within(receipt).getByRole("button", { name: /Enviar por WhatsApp/ }),
    );
    await waitFor(() => expect(open).toHaveBeenCalled());
    const url = decodeURIComponent(String((open.mock.calls[0] as unknown[])[0]));
    expect(url).toContain("Finca");
  }, 30000);

  it("lists each deduction the slip carries", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getPayment").mockResolvedValue({
      id: "p",
      kind: "pago",
      workerId: MARIA,
      date: "2026-08-30",
      method: "efectivo",
      paidCents: 100_000,
      previousBalanceCents: 0,
      currentWeekCents: 0,
      currentWeekFrom: null,
      currentWeekTo: null,
      deductions: [
        { concept: "Préstamo de herramienta", amountCents: 20_000, date: "2026-08-28" },
      ],
      deductionsCents: 20_000,
      remainingCents: 0,
      settlementId: null,
      settlementIds: [],
      note: null,
      reversed: false,
    });
    renderPay();
    await payTotal(user);
    const receipt = await dialogTitled("Pago registrado");
    expect(
      within(receipt).getByText("Descuento · Préstamo de herramienta"),
    ).toBeInTheDocument();
    expect(within(receipt).queryByText("Semana actual")).not.toBeInTheDocument();
  }, 30000);
});

describe("the difference dialog with rows that came and went", () => {
  it("lists what entered and what left, and counts the repriced weeks", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "createPayment").mockRejectedValue(
      new ApiError(409, {
        error: {
          code: "GROSS_CHANGED",
          message: "changed",
          details: {
            beforeCents: 100_000,
            afterCents: 130_000,
            addedIds: ["a1"],
            removedIds: ["r1"],
            added: [line("a1", "Recolección tarde", 40_000)],
            removed: [line("r1", "Desyerba", 10_000)],
            repriced: [
              { weekStart: "2026-08-17", fromRateCents: 80_000, toRateCents: 84_000, lineCount: 1 },
              { weekStart: "2026-08-24", fromRateCents: 80_000, toRateCents: 84_000, lineCount: 1 },
            ],
            causeIsKnown: true,
          },
        },
      }),
    );
    renderPay();
    await payTotal(user);
    const dialog = await dialogTitled("El total cambió mientras revisaba");
    expect(within(dialog).getByText("Entró")).toBeInTheDocument();
    expect(within(dialog).getByText("Recolección tarde")).toBeInTheDocument();
    expect(within(dialog).getByText("Salió")).toBeInTheDocument();
    expect(within(dialog).getByText("Desyerba")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/2 labores se pagan al precio de la semana/),
    ).toBeInTheDocument();
  }, 30000);
});

describe("a payment refused as larger than the balance, naming no balance", () => {
  function refuseWithoutBalance() {
    server.use(
      http.post("*/v1/payments", () =>
        HttpResponse.json(
          {
            error: {
              code: "AMOUNT_EXCEEDS_BALANCE",
              message: "too much",
              details: {},
            },
          },
          { status: 422 },
        ),
      ),
    );
  }

  it("reads the balance as zero, and Escape closes the question", async () => {
    const user = userEvent.setup();
    refuseWithoutBalance();
    renderPay();
    await payTotal(user);
    const excess = await dialogTitled("El valor supera el saldo");
    expect(excess).toHaveTextContent(/el saldo pendiente es \$\s?0\./);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("El valor supera el saldo")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Pago registrado")).not.toBeInTheDocument();
  }, 30000);

  it("does not pay when the advance button is pressed as the dialog closes", async () => {
    const user = userEvent.setup();
    refuseWithoutBalance();
    renderPay();
    await payTotal(user);
    const excess = await dialogTitled("El valor supera el saldo");
    const advance = within(excess).getByRole("button", {
      name: "Pagar y registrar anticipo",
    });
    const create = vi.spyOn(api, "createPayment");
    fireEvent.click(within(excess).getByRole("button", { name: "Corregir el valor" }));
    fireEvent.click(advance);
    await waitFor(() =>
      expect(screen.queryByText("El valor supera el saldo")).not.toBeInTheDocument(),
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByText("Pago registrado")).not.toBeInTheDocument();
  }, 30000);
});

describe("a team's member list", () => {
  async function createTeam() {
    await api.createWorker({
      id: TEAM,
      name: "Los Primos",
      tag: "40",
      kind: "equipo",
      memberIds: [JHON, LUZ],
    } as Parameters<typeof api.createWorker>[0]);
    invalidateRefs();
  }

  it("still reads when the server sends no members at all", async () => {
    await createTeam();
    const real = api.getWorker.bind(api);
    vi.spyOn(api, "getWorker").mockImplementation(async (id) => {
      const w = await real(id);
      return { ...w, members: undefined };
    });
    renderPay(TEAM);
    expect(
      await screen.findByText(/Pagar al equipo/, undefined, { timeout: 15000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cuenta del equipo").parentElement).toHaveTextContent(
      /^Cuenta del equipo\. Se liquida/,
    );
    expect(
      screen.queryByRole("combobox", { name: /Quién recibe la plata/ }),
    ).not.toBeInTheDocument();
  }, 30000);

  it("names a member without a last name, and a receiver who left the team as nobody", async () => {
    const user = userEvent.setup();
    await createTeam();
    const real = api.getWorker.bind(api);
    let paid = false;
    let reloaded = false;
    vi.spyOn(api, "getWorker").mockImplementation(async (id) => {
      const w = await real(id);
      if (paid) reloaded = true;
      const members: Worker["members"] = paid
        ? undefined
        : [{ id: LUZ, name: "Luz", lastName: null, tag: null, from: "2026-01-01", to: null }];
      return { ...w, members };
    });
    vi.spyOn(api, "createPayment").mockImplementation(async (body) => {
      paid = true;
      return fakePayment(TEAM, body.amountCents);
    });
    renderPay(TEAM);
    await user.click(
      await screen.findByRole(
        "combobox",
        { name: /Quién recibe la plata/ },
        { timeout: 15000 },
      ),
    );
    await user.click(await screen.findByRole("option", { name: "Luz" }));
    await user.type(screen.getByLabelText("Valor"), "10000");
    let confirm = await openConfirm(user, "Revisar");
    expect(within(confirm).getByText("Luz")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: /^Pagar \$/ }));
    const receipt = await dialogTitled("Pago registrado");
    await user.click(within(receipt).getByRole("button", { name: "Seguir aquí" }));
    await waitFor(() =>
      expect(screen.queryByText("Pago registrado")).not.toBeInTheDocument(),
    );
    // The reload brought the team back without its member list, but the
    // receiver chosen before is still set: the dialog names nobody.
    await waitFor(() => expect(reloaded).toBe(true));
    await user.type(screen.getByLabelText("Valor"), "5000");
    confirm = await openConfirm(user, "Revisar");
    const recibe = within(confirm).getByText(/Recibe:/);
    expect(recibe.querySelector("strong")).toHaveTextContent(/^$/);
  }, 40000);
});
