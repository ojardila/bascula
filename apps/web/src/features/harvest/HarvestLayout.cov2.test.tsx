// SPDX-License-Identifier: MIT
/**
 * The frame around the harvest readings: an unknown period in the URL, a farm
 * with no timezone on record, changing the period, and a screen mounted
 * outside the frame.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { FARM_ID } from "../../mocks/db";
import { OWNER, signInOwner } from "../../test/renderWithAuth";
import { todayInFarm } from "../../lib/dates";
import { HarvestLayout, useHarvest } from "./HarvestLayout";

function Probe() {
  const h = useHarvest();
  const loc = useLocation();
  return (
    <p>
      Ventana de {h.weeks} semanas desde {h.today} · {loc.search}
    </p>
  );
}

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="cosecha" element={<HarvestLayout />}>
              <Route path="detalles" element={<Probe />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  invalidateRefs();
});

describe("HarvestLayout", () => {
  it("reads an unknown period as the season and a farm without a timezone as Bogotá", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: OWNER,
          email: "dueno@example.com",
          name: "Dueño",
          role: "owner",
          farm: { id: FARM_ID, name: "La Palma", timezone: "", currency: "COP", slug: "lapalma" },
          superadmin: false,
        }),
      ),
    );
    renderAt("/cosecha/detalles?rango=7");
    expect(
      await screen.findByText(
        new RegExp(`Ventana de 26 semanas desde ${todayInFarm("America/Bogota")}`),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Más detalles de la cosecha" })).toBeInTheDocument();
  });

  it("puts the chosen period in the address", async () => {
    signInOwner();
    const user = userEvent.setup();
    renderAt("/cosecha/detalles");
    await screen.findByText(/Ventana de 26 semanas/);
    await user.click(screen.getByRole("combobox", { name: "Periodo" }));
    await user.click(await screen.findByRole("option", { name: "Últimas 12 semanas" }));
    expect(await screen.findByText(/Ventana de 12 semanas .*\?rango=12/)).toBeInTheDocument();
  });

  it("refuses to give a harvest screen its context outside the frame", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useHarvest fuera de <HarvestLayout>");
    err.mockRestore();
  });
});
