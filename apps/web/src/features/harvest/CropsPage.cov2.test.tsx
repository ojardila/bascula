// SPDX-License-Identifier: MIT
/**
 * «Por cultivo»: a 403 on the plots, and exactly one crop that fails to load.
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
import { FARM_ID, tenantOf } from "../../mocks/db";
import { HarvestLayout } from "./HarvestLayout";
import { CropsPage } from "./CropsPage";

function renderPage() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/cultivos"]}>
        <AuthProvider>
          <Routes>
            <Route path="cosecha" element={<HarvestLayout />}>
              <Route path="cultivos" element={<CropsPage />} />
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

describe("CropsPage", () => {
  it("leaves the module when the server refuses the lotes", async () => {
    signInOwner();
    server.use(http.get("*/v1/plots", fail(403)));
    renderPage();
    expect(await screen.findByText("No tiene permiso para ver la cosecha")).toBeInTheDocument();
  });

  it("names the one crop that could not be loaded, in the singular", async () => {
    signInOwner();
    const ids = tenantOf(FARM_ID)!
      .plots.filter((p) => !p.deletedAt)
      .flatMap((p) => (p.crops ?? []).map((c) => c.id));
    expect(ids.length).toBeGreaterThan(1);
    server.use(
      // One crop fails; the others fall through to the farm's real report.
      http.get("*/v1/reports/crops/:id", ({ params }) => (params.id === ids[0] ? fail(500)() : undefined)),
    );
    renderPage();
    expect(await screen.findByText(/1 cultivo no se pudo consultar/)).toBeInTheDocument();
  });
});
