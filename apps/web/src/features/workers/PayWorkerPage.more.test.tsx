// SPDX-License-Identifier: MIT
/**
 * The payment screen beyond the race: the receipt and what can be done with
 * it, a payment larger than what is owed, failures, teams, and the screens
 * shown instead of the form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { PayWorkerPage } from "./PayWorkerPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const print = vi.hoisted(() => ({ ok: true }));
vi.mock("../documents/print", () => ({
  printDocument: vi.fn(() => print.ok),
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
            <Route path="/empleados/:id" element={<p>perfil del empleado</p>} />
            <Route
              path="/empleados/:id/historial/pago/:paymentId"
              element={<p>recibo del pago</p>}
            />
            <Route path="/labores/nueva" element={<p>nueva labor</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  print.ok = true;
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => vi.unstubAllGlobals());

async function confirmDialog() {
  const title = await screen.findByText(/^Entregar \$/);
  return title.closest('[role="dialog"]') as HTMLElement;
}

async function receiptDialog() {
  const title = await screen.findByText("Pago registrado");
  return title.closest('[role="dialog"]') as HTMLElement;
}

async function payTotal(user: User) {
  await user.click(
    await screen.findByRole("button", { name: /Revisar y pagar/ }),
  );
  const dialog = await confirmDialog();
  await user.click(within(dialog).getByRole("button", { name: /^Pagar \$/ }));
}

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

describe("the receipt", () => {
  it("tells when printing or WhatsApp could not open", async () => {
    const user = userEvent.setup();
    print.ok = false;
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await user.click(screen.getByRole("combobox", { name: "Forma de pago" }));
    await user.click(
      await screen.findByRole("option", { name: "Transferencia" }),
    );
    await payTotal(user);
    const receipt = await receiptDialog();
    await user.click(
      within(receipt).getByRole("button", { name: /Imprimir recibo/ }),
    );
    await user.click(
      within(receipt).getByRole("button", { name: /Enviar por WhatsApp/ }),
    );
    await user.click(
      within(receipt).getByRole("button", { name: "Seguir aquí" }),
    );
    expect(
      await screen.findByText(/No se pudo abrir WhatsApp/),
    ).toBeInTheDocument();
    const alert = screen
      .getByText(/No se pudo abrir WhatsApp/)
      .closest('[role="alert"]') as HTMLElement;
    await user.click(within(alert).getByRole("button", { hidden: true }));
    await waitFor(() =>
      expect(
        screen.queryByText(/No se pudo abrir WhatsApp/),
      ).not.toBeInTheDocument(),
    );
  }, 20000);

  it("prints, opens WhatsApp and goes to the receipt page", async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await payTotal(user);
    const receipt = await receiptDialog();
    await user.click(
      within(receipt).getByRole("button", { name: /Imprimir recibo/ }),
    );
    await user.click(
      within(receipt).getByRole("button", { name: /Enviar por WhatsApp/ }),
    );
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(screen.queryByText(/No se pudo abrir/)).not.toBeInTheDocument();
    await user.click(
      within(receipt).getByRole("button", { name: "Ver recibo" }),
    );
    expect(await screen.findByText("recibo del pago")).toBeInTheDocument();
  }, 20000);

  it("goes to the profile from the receipt", async () => {
    const user = userEvent.setup();
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await payTotal(user);
    const receipt = await receiptDialog();
    await user.click(
      within(receipt).getByRole("button", { name: "Ver el perfil" }),
    );
    expect(await screen.findByText("perfil del empleado")).toBeInTheDocument();
  }, 20000);
});

describe("paying more than is owed", () => {
  it("offers to record the excess as an advance", async () => {
    const user = userEvent.setup();
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await user.type(screen.getByLabelText("Valor"), "99999999");
    expect(screen.getByText(/Es más que el total/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revisar" }));
    const confirm = await confirmDialog();
    await user.click(
      within(confirm).getByRole("button", { name: /^Pagar \$/ }),
    );
    const title = await screen.findByText("El valor supera el saldo");
    const excess = title.closest('[role="dialog"]') as HTMLElement;
    await user.click(
      within(excess).getByRole("button", {
        name: "Pagar y registrar anticipo",
      }),
    );
    expect(await screen.findByText("Pago registrado")).toBeInTheDocument();
    const advances = db
      .tenantOf(db.FARM_ID)!
      .ledger.filter((e) => e.kind === "anticipo" && e.workerId === MARIA);
    expect(
      advances.some(
        (e) => e.note === "Excedente del pago, registrado como anticipo",
      ),
    ).toBe(true);
  }, 20000);

  it("lets the value be corrected instead", async () => {
    const user = userEvent.setup();
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await user.type(screen.getByLabelText("Valor"), "99999999");
    await user.click(screen.getByRole("button", { name: "Revisar" }));
    await user.click(
      within(await confirmDialog()).getByRole("button", { name: /^Pagar \$/ }),
    );
    const title = await screen.findByText("El valor supera el saldo");
    await user.click(
      within(title.closest('[role="dialog"]') as HTMLElement).getByRole(
        "button",
        {
          name: "Corregir el valor",
        },
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("El valor supera el saldo"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Pago registrado")).not.toBeInTheDocument();
  }, 20000);
});

describe("failures", () => {
  it("shows a payment the server refused for another reason", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/payments", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await payTotal(user);
    expect(await screen.findByText(/no tiene permiso/)).toBeInTheDocument();
  }, 20000);

  it("still shows the receipt when the payment slip cannot be read", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/payments/:id", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom", details: {} } },
          { status: 500 },
        ),
      ),
    );
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    await payTotal(user);
    const receipt = await receiptDialog();
    await user.click(
      within(receipt).getByRole("button", { name: /Imprimir recibo/ }),
    );
    expect(
      screen.queryByText(/No se pudo abrir la impresión/),
    ).not.toBeInTheDocument();
  }, 20000);

  it("says when the worker cannot be loaded", async () => {
    server.use(
      http.get("*/v1/workers/:id", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "se cayó", details: {} } },
          { status: 500 },
        ),
      ),
    );
    renderPay();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("refuses a user who may not pay", async () => {
    server.use(
      http.get("*/v1/workers/:id", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    renderPay();
    expect(await screen.findByText(/pagar a un empleado/)).toBeInTheDocument();
  });
});

describe("the selection", () => {
  it("unticks and ticks a work item again", async () => {
    const user = userEvent.setup();
    renderPay();
    await screen.findByText("Labores pendientes de liquidar");
    const [first] = screen.getAllByRole("checkbox");
    await user.click(first);
    expect(first).not.toBeChecked();
    await user.click(first);
    expect(first).toBeChecked();
    await user.click(screen.getByRole("button", { name: /Perfil de María/ }));
    expect(await screen.findByText("perfil del empleado")).toBeInTheDocument();
  });
});

describe("teams", () => {
  it("pays the team once and says who received the money", async () => {
    const user = userEvent.setup();
    await createTeam();
    renderPay(TEAM);
    expect(await screen.findByText(/Pagar al equipo/)).toBeInTheDocument();
    expect(screen.getByText(/Jhon Fredy y Luz Dary/)).toBeInTheDocument();
    expect(screen.getByText(/No hay nada que pagar/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: /Quién recibe la plata/ }),
    );
    await user.click(await screen.findByRole("option", { name: /Luz Dary/ }));
    await user.type(screen.getByLabelText("Valor"), "10000");
    await user.click(screen.getByRole("button", { name: "Revisar" }));
    const confirm = await confirmDialog();
    expect(within(confirm).getByText("Luz Dary")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Ahora no" }));
    await waitFor(() =>
      expect(screen.queryByText(/^Entregar \$/)).not.toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", { name: "Registrar una labor" }),
    );
    expect(await screen.findByText("nueva labor")).toBeInTheDocument();
  }, 20000);

  it("tells a member that their kilos are paid to the team", async () => {
    await createTeam();
    renderPay(JHON);
    expect(
      await screen.findByText(/sus kilos se pagan en la cuenta del equipo/),
    ).toBeInTheDocument();
  });
});
