// SPDX-License-Identifier: MIT
/**
 * «Revisión de pesadas»: a refused or failed load, and a list cut at its limit.
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
import { ReviewPage } from "./ReviewPage";

function renderPage() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/revision"]}>
        <AuthProvider>
          <Routes>
            <Route path="cosecha" element={<HarvestLayout />}>
              <Route path="revision" element={<ReviewPage />} />
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

const item = (n: number) => ({
  recordId: `r${n}`,
  workerId: "w1",
  worker: "María Restrepo",
  crop: "Café — La Cuchilla",
  quantity: 40 + n,
  kg: 40 + n,
  date: "2099-01-01",
  rule: "future",
  reference: null,
});

describe("ReviewPage", () => {
  it("leaves the module when the server refuses the review", async () => {
    signInOwner();
    server.use(http.get("*/v1/reports/anomalies", fail(403)));
    renderPage();
    expect(await screen.findByText("No tiene permiso para ver la cosecha")).toBeInTheDocument();
  });

  it("says the review could not be done, which is not the same as nothing to review", async () => {
    signInOwner();
    server.use(http.get("*/v1/reports/anomalies", fail(500)));
    renderPage();
    expect(await screen.findByText(/No se pudieron consultar las pesadas/)).toBeInTheDocument();
    expect(screen.queryByText(/merece|merecen/)).not.toBeInTheDocument();
  });

  it("counts several weighings and says when the list stops at its limit", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/anomalies", () =>
        HttpResponse.json({
          scope: "harvest",
          days: 182,
          maxKg: 120,
          limit: 2,
          since: "2026-01-05",
          items: [item(1), item(2)],
        }),
      ),
    );
    renderPage();
    expect(await screen.findByText(/2 pesadas merecen una/)).toBeInTheDocument();
    expect(screen.getByText(/Se muestran las 2 primeras; puede haber más\./)).toBeInTheDocument();
  });
});
