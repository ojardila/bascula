// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SettlementsPage } from "./SettlementsPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import { invalidateRefs } from "../../api/refs";
import type { SettlementSummary } from "../../api/types";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import * as print from "../documents/print";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderAt() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/liquidaciones"]}>
        <AuthProvider>
          <Routes>
            <Route path="/liquidaciones" element={<SettlementsPage />} />
            <Route path="/liquidaciones/:id" element={<p>Detalle abierto</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const row = (p: Partial<SettlementSummary>): SettlementSummary =>
  ({
    id: "s1",
    workerId: "w1",
    workerName: "Ana Ruiz",
    periodStart: "2026-08-24",
    periodEnd: "2026-08-30",
    grossCents: 1_000_000,
    status: "open",
    lineCount: 2,
    note: null,
    createdAt: "2026-08-31T10:00:00Z",
    voidedAt: null,
    ...p,
  }) as SettlementSummary;

const list = (items: SettlementSummary[], unreadableLedgers = 0, unreadableSettlements = 0) =>
  vi.spyOn(api, "listSettlements").mockResolvedValue({ items, unreadableLedgers, unreadableSettlements });

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

describe("settlements list, the remaining paths", () => {
  it("sends a refused read to the permission screen", async () => {
    vi.spyOn(api, "listSettlements").mockRejectedValue(
      new ApiError(403, { error: { code: "FORBIDDEN", message: "no" } }),
    );
    renderAt();
    expect(await screen.findByText(/ver las liquidaciones/)).toBeInTheDocument();
  });

  it("shows any other failure", async () => {
    vi.spyOn(api, "listSettlements").mockRejectedValue(
      new ApiError(500, { error: { code: "INTERNAL", message: "Se cayó el servidor." } }),
    );
    renderAt();
    expect(await screen.findByText(/El servidor tuvo un problema/)).toBeInTheDocument();
  });

  it("says plainly that nothing has been settled on a farm with no settlements", async () => {
    list([]);
    renderAt();
    expect(await screen.findByText("Todavía no se ha liquidado nada en esta finca.")).toBeInTheDocument();
  });

  it("counts one unreadable ledger and one unreadable settlement in the singular", async () => {
    list([row({})], 1, 1);
    renderAt();
    const alert = await screen.findByText("Esta lista está incompleta.");
    const text = alert.parentElement!.textContent!;
    expect(text).toContain("No se pudo leer el libro de 1 empleado,");
    expect(text).toContain("1 liquidación no se pudo consultar.");
  });

  it("counts several unreadable settlements in the plural", async () => {
    list([row({})], 0, 2);
    renderAt();
    const alert = await screen.findByText("Esta lista está incompleta.");
    expect(alert.parentElement!.textContent).toContain("2 liquidaciones no se pudieron consultar.");
  });

  it("filters by status, says when nothing matches, prints the whole sheet and opens a row", async () => {
    const printDocument = vi.spyOn(print, "printDocument").mockReturnValue(true);
    list([row({}), row({ id: "s2", workerName: "Beto Gil", status: "void", voidedAt: null })]);
    const user = userEvent.setup();
    renderAt();
    expect(await screen.findByText("Beto Gil")).toBeInTheDocument();
    expect(screen.getByText("Anulada")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Planilla" }));
    expect(printDocument.mock.calls[0][0]).toContain("Planilla de liquidaciones");
    expect(printDocument.mock.calls[0][0]).not.toContain("(parcial)");

    await user.click(screen.getByRole("combobox", { name: "Estado" }));
    await user.click(await screen.findByRole("option", { name: "Anuladas" }));
    expect(await screen.findByText(/solo las anuladas/)).toBeInTheDocument();
    expect(screen.queryByText("Ana Ruiz")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Estado" }));
    await user.click(await screen.findByRole("option", { name: "Vigentes" }));
    expect(await screen.findByText(/solo las vigentes/)).toBeInTheDocument();
    expect(screen.queryByText("Beto Gil")).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Buscar por empleado" }), "zzz");
    expect(await screen.findByText("Ninguna liquidación coincide con el filtro.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar el filtro" }));
    await user.click(within(screen.getAllByRole("row")[1]).getByText("Ana Ruiz"));
    expect(await screen.findByText("Detalle abierto")).toBeInTheDocument();
  });
});
