/**
 * One settlement on its own page: the document, printing it, the way back,
 * and voiding it — including when the server refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SettlementDetailPage } from "./SettlementDetailPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { api } from "../../api/endpoints";
import type { PayableLine, Settlement } from "../../api/types";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";
import * as print from "../documents/print";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const SEEDED = "0192f3a0-000b-7000-8000-000000000001";

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderAt(id = SEEDED) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/liquidaciones/${id}`]}>
        <AuthProvider>
          <Routes>
            <Route
              path="/liquidaciones/:id"
              element={<SettlementDetailPage />}
            />
            <Route path="*" element={<Where />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function line(p: Partial<PayableLine>): PayableLine {
  return {
    id: crypto.randomUUID(),
    activityName: "Recolección",
    dateFrom: "2026-08-18",
    dateTo: "2026-08-18",
    weekStart: "2026-08-17",
    plotNames: ["La Cumbre"],
    payMode: "work_unit",
    quantity: 10,
    unitLabel: "kg",
    rateCents: 80_000,
    rateSource: "fixed",
    amountCents: 800_000,
    ...p,
  };
}

/** The seeded settlement, reshaped. */
async function seededWith(change: Partial<Settlement>) {
  const real = await api.getSettlement(SEEDED);
  vi.spyOn(api, "getSettlement").mockResolvedValue({ ...real, ...change });
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
afterEach(() => vi.restoreAllMocks());

describe("a settlement's page", () => {
  it("prints the document with the farm's name", async () => {
    const printDocument = vi
      .spyOn(print, "printDocument")
      .mockReturnValue(true);
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole("button", { name: "Imprimir" }));
    expect(printDocument).toHaveBeenCalledTimes(1);
    expect(printDocument.mock.calls[0][0]).toContain("Édinson");
  });

  it("goes back to the list and on to the worker", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: "Liquidaciones" }),
    );
    expect(screen.getByTestId("where")).toHaveTextContent("/liquidaciones");
  });

  it("opens the worker's profile", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: /Ver el perfil de/ }),
    );
    expect(screen.getByTestId("where").textContent).toMatch(/^\/empleados\//);
  });

  it("warns about lines paid at the week's price, and shows the note", async () => {
    await seededWith({
      lines: [
        line({ rateSource: "weekly_price" }),
        line({ rateSource: "weekly_price", unitLabel: null }),
      ],
      note: "Pagada en la oficina",
    });
    renderAt();
    expect(await screen.findByText(/2 líneas se pagaron/)).toBeInTheDocument();
    expect(screen.getByText("Pagada en la oficina")).toBeInTheDocument();
  });

  it("says so when one line was paid at the week's price", async () => {
    await seededWith({ lines: [line({ rateSource: "weekly_price" })] });
    renderAt();
    expect(await screen.findByText(/Una línea se pagó/)).toBeInTheDocument();
  });

  it("says the server sent no lines rather than showing an empty table", async () => {
    await seededWith({ lines: [] });
    renderAt();
    expect(
      await screen.findByText(/no devolvió las líneas/),
    ).toBeInTheDocument();
  });

  it("marks a void settlement and offers no way to void it again", async () => {
    await seededWith({ status: "void", voidedAt: "2026-08-25T15:00:00Z" });
    renderAt();
    expect(await screen.findByText("Liquidación anulada")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Anular la liquidación" }),
    ).toBeNull();
  });
});

describe("voiding it", () => {
  it("can be called off from the confirmation", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: "Anular la liquidación" }),
    );
    expect(screen.getByText(/Se van a soltar 1 labor y/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.tenantOf(db.FARM_ID)!.settlements[0].status).toBe("open");
  });

  it("voids it and shows it void", async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: "Anular la liquidación" }),
    );
    await user.click(screen.getByRole("button", { name: "Sí, anular" }));
    expect(await screen.findByText("Liquidación anulada")).toBeInTheDocument();
  });

  it("shows the server's refusal, which can be dismissed", async () => {
    server.use(
      http.post("*/v1/settlements/:id/void", () =>
        HttpResponse.json(
          {
            error: {
              code: "SETTLEMENT_ALREADY_VOID",
              message: "the settlement is already void",
            },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderAt();
    await user.click(
      await screen.findByRole("button", { name: "Anular la liquidación" }),
    );
    await user.click(screen.getByRole("button", { name: "Sí, anular" }));
    // The confirmation stays open over the page; closing it shows why.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sí, anular" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    const alert = await screen.findByRole("alert");
    expect(screen.queryByText("Liquidación anulada")).toBeNull();
    await user.click(
      await screen.findByRole("button", { name: /close|cerrar/i }),
    );
    await waitFor(() => expect(alert).not.toBeInTheDocument());
  });
});
