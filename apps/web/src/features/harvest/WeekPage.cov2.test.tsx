// SPDX-License-Identifier: MIT
/**
 * The week detail, for what the page tests do not reach: a refused or failed
 * load, an address that names no week, the running week, a grid that does not
 * cross-foot, an unattributed day column, and a session that may not see money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";
import { mondayOf } from "../../lib/dates";
import type { WireReportGrid, WireReportTotals } from "../../api/wire";
import { HarvestLayout } from "./HarvestLayout";
import { WeekPage } from "./WeekPage";

const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";
const today = new Date().toISOString().slice(0, 10);
const thisMonday = mondayOf(today);

const totals = (over: Partial<WireReportTotals> = {}): WireReportTotals => ({
  records: 0,
  kg: null,
  recordsNotInKg: 0,
  valueCents: null,
  recordsWithoutValue: 0,
  valueIsEstimate: false,
  recordsSpanningWeeks: 0,
  ...over,
});
const kg = (n: number, records = 1) => totals({ records, kg: n, valueCents: n * 1000 });

function renderWeek(monday: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`/cosecha/semana/${monday}`]}>
        <AuthProvider>
          <Routes>
            <Route path="cosecha" element={<HarvestLayout />}>
              <Route path="semana/:monday" element={<WeekPage />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function serveWeek(byDay: WireReportGrid, total: WireReportTotals) {
  server.use(
    http.get("*/v1/reports/weeks/:monday", () =>
      HttpResponse.json({
        scope: "harvest",
        weekStart: thisMonday,
        finished: false,
        coveredFrom: thisMonday,
        coveredTo: today,
        partialWindow: false,
        byDay,
        byCrop: byDay,
        total,
      }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  invalidateRefs();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640, height: 200, top: 0, left: 0, right: 640, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

describe("WeekPage", () => {
  it("leaves the module when the server refuses the week", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/weeks/:monday", () =>
        HttpResponse.json({ error: { code: "forbidden", message: "forbidden" } }, { status: 403 }),
      ),
    );
    renderWeek(thisMonday);
    expect(await screen.findByText("No tiene permiso para ver la cosecha")).toBeInTheDocument();
  });

  it("explains how a week is named when the address names none", async () => {
    signInOwner();
    renderWeek("no-es-lunes");
    expect(await screen.findByText(/«no-es-lunes» no nombra una semana/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a la temporada" })).toBeInTheDocument();
  });

  it("says no figure is zero when the week fails to load", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/weeks/:monday", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderWeek(thisMonday);
    expect(await screen.findByText(/No se pudo consultar la semana/)).toBeInTheDocument();
  });

  it("marks the running week, warns when the grid does not add up, and opens today's masivo", async () => {
    signInOwner();
    serveWeek(
      {
        columns: [
          { key: thisMonday, label: thisMonday, total: kg(30) },
          { key: null, label: "Sin fecha", total: kg(10) },
        ],
        rows: [
          { workerId: "w1", name: "María Restrepo", cells: [{ column: thisMonday, ...kg(30) }], total: kg(30) },
        ],
        total: kg(40, 2),
      },
      kg(40, 2),
    );
    renderWeek(thisMonday);
    expect(await screen.findByText("semana en curso")).toBeInTheDocument();
    expect(screen.getByText(/no cuadran por filas y columnas/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Registro masivo" })).toHaveAttribute(
      "href",
      `/cosecha/registro-masivo?dia=${today}`,
    );
    expect(screen.getByText("Valor de la semana")).toBeInTheDocument();
    const chart = screen.getByRole("img", { name: "Kilos recolectados cada día de la semana." });
    expect(within(chart).getByText("Sin fecha")).toBeInTheDocument();
  });

  it("shows a weigher the kilos and no money", async () => {
    signInOwner(WEIGHER);
    serveWeek(
      {
        columns: [{ key: thisMonday, label: thisMonday, total: kg(30) }],
        rows: [
          { workerId: "w1", name: "María Restrepo", cells: [{ column: thisMonday, ...kg(30) }], total: kg(30) },
        ],
        total: kg(30),
      },
      kg(30),
    );
    renderWeek(thisMonday);
    expect(await screen.findByText("Quién recogió, y dónde")).toBeInTheDocument();
    expect(screen.getByText("Recogido")).toBeInTheDocument();
    expect(screen.queryByText("Valor de la semana")).not.toBeInTheDocument();
  });
});
