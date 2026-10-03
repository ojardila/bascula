// SPDX-License-Identifier: MIT
/**
 * The variety picker against two server behaviours the mock does not have:
 * a catalogue whose varieties carry their crop type (only the crop's own are
 * offered), and a "create" that answers with a variety the list already has
 * (the plot is saved with it, and the list keeps one copy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { PlotFormPage } from "./PlotFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { PLOT } from "../../lib/vocab";
import { signInOwner } from "../../test/renderWithAuth";

const CAFE = "0192f3a0-0002-7000-8000-000000000001";
const AGUACATE = "0192f3a0-0002-7000-8000-000000000002";
const CASTILLO = "0192f3a0-0003-7000-8000-000000000001";

type User = ReturnType<typeof userEvent.setup>;

function c3wRenderForm() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[`${PLOT.path}/nuevo`]}>
        <AuthProvider>
          <Routes>
            <Route path={`${PLOT.path}/nuevo`} element={<PlotFormPage />} />
            <Route path={`${PLOT.path}/:id`} element={<p>detalle del lote</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function c3wToCrops(user: User, name: string) {
  await user.type(await screen.findByLabelText(/Nombre del lote/), name);
  await user.type(screen.getByLabelText(/Superficie total/), "4,20");
  await user.click(screen.getByLabelText(/Departamento/));
  await user.click(await screen.findByRole("option", { name: "Huila" }));
  await user.type(screen.getByLabelText(/Municipio/), "Pitalito");
  await user.click(screen.getByRole("button", { name: "Continuar" }));
  await screen.findByDisplayValue("Café");
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signInOwner();
});
afterEach(() => vi.restoreAllMocks());

describe("PlotFormPage varieties", () => {
  it("offers only the varieties of the row's crop when the catalogue says which is which", async () => {
    vi.spyOn(api, "varieties").mockResolvedValue([
      { id: CASTILLO, name: "Castillo", cropTypeId: CAFE },
      { id: "v-c3w-hass", name: "Hass", cropTypeId: AGUACATE },
    ]);
    const user = userEvent.setup();
    c3wRenderForm();
    await c3wToCrops(user, "Por cultivo");
    await user.click(screen.getAllByLabelText(/Variedad/)[0]);
    expect(await screen.findByRole("option", { name: "Castillo" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Hass" })).not.toBeInTheDocument();
  }, 30_000);

  it("saves the existing variety when creating one answers with it", async () => {
    vi.spyOn(api, "createVariety").mockResolvedValue({ id: CASTILLO, name: "Castillo" });
    const user = userEvent.setup();
    c3wRenderForm();
    await c3wToCrops(user, "Sin repetir");
    const variety = screen.getAllByLabelText(/Variedad/)[0];
    await user.type(variety, "castillo nuevo");
    await user.click(await screen.findByRole("option", { name: "Agregar «castillo nuevo»" }));
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    expect(api.createVariety).toHaveBeenCalledTimes(1);
    const saved = db.tenantOf(db.FARM_ID)!.plots.find((p) => p.name === "Sin repetir")!;
    expect(JSON.stringify(saved)).toContain(CASTILLO);
  }, 30_000);
});
