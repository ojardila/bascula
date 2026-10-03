// SPDX-License-Identifier: MIT
/**
 * «Rendimiento»: a refused or failed load, an empty window, and the trend chip
 * in both directions with singular counts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";

import { HarvestLayout } from "./HarvestLayout";
import { YieldPage } from "./YieldPage";

function renderPage() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/rendimiento"]}>
        <AuthProvider>
          <Routes>
            <Route path="cosecha" element={<HarvestLayout />}>
              <Route path="rendimiento" element={<YieldPage />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const fail = (status: number) => () =>
  HttpResponse.json({ error: { code: status === 403 ? "forbidden" : "internal", message: "x" } }, { status });

beforeEach(() => {
  localStorage.clear();
  invalidateRefs();
});

const person = (name: string, index: number | null, over = {}) => ({
  workerId: `w-${name}`,
  name,
  records: 1,
  kg: 20,
  recordsNotInKg: 0,
  valueCents: 16_000,
  recordsWithoutValue: 0,
  valueIsEstimate: false,
  recordsSpanningWeeks: 0,
  days: 1,
  kgPerDay: 20,
  index,
  comparableDays: 1,
  trend: null,
  ...over,
});

function servePerformance(items: unknown[]) {
  server.use(
    http.get("*/v1/reports/performance", () =>
      HttpResponse.json({ scope: "harvest", days: 182, since: "2026-01-05", minComparableDays: 1, items }),
    ),
  );
}

describe("YieldPage", () => {
  it("leaves the module when the server refuses the report", async () => {
    signInOwner();
    server.use(http.get("*/v1/reports/performance", fail(403)));
    renderPage();
    expect(await screen.findByText("No tiene permiso para ver la cosecha")).toBeInTheDocument();
  });

  it("says no index is shown, and none is zero, when the report fails", async () => {
    signInOwner();
    server.use(http.get("*/v1/reports/performance", fail(500)));
    renderPage();
    expect(await screen.findByText(/No se pudo consultar el rendimiento/)).toBeInTheDocument();
  });

  it("says there is nobody to compare in a window without picking", async () => {
    signInOwner();
    servePerformance([]);
    renderPage();
    expect(await screen.findByText(/Nadie registró recolección en esta ventana/)).toBeInTheDocument();
  });

  it("shows the trend going up and going down, with singular counts", async () => {
    signInOwner();
    servePerformance([
      person("Ana Pérez", 1.3, { trend: 1.4 }),
      person("Beto Pérez", 0.8, { trend: 0.6 }),
      person("Cira Pérez", 1.0, { trend: 1.05 }),
    ]);
    renderPage();
    expect(await screen.findByText("va subiendo")).toBeInTheDocument();
    expect(screen.getByText("va bajando")).toBeInTheDocument();
    expect(screen.getAllByText("1 día comparable")).toHaveLength(3);
    expect(screen.getAllByText("1 día trabajado")).toHaveLength(3);
  });
});
