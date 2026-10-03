// SPDX-License-Identifier: MIT
/**
 * The plot form: two steps, the default coffee row, typed-in catalogue
 * entries, editing an existing plot, and the errors on the way.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { PlotFormPage } from "./PlotFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { PLOT } from "../../lib/vocab";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

function renderForm(path = `${PLOT.path}/nuevo`) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path={`${PLOT.path}/nuevo`} element={<PlotFormPage />} />
            <Route path={`${PLOT.path}/:id/editar`} element={<PlotFormPage />} />
            <Route path={`${PLOT.path}/:id`} element={<p>detalle del lote</p>} />
            <Route path={PLOT.path} element={<p>lista de lotes</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function fillStep1(user: ReturnType<typeof userEvent.setup>, name = "El Mirador Nuevo") {
  await user.type(screen.getByLabelText(/Nombre del lote/), name);
  await user.type(screen.getByLabelText(/Superficie total/), "4,20");
  await user.click(screen.getByLabelText(/Departamento/));
  await user.click(await screen.findByRole("option", { name: "Huila" }));
  await user.type(screen.getByLabelText(/Municipio/), "Pitalito");
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

describe("creating a plot", () => {
  it("asks for every field of step 1 before moving on", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Escriba el nombre del lote.")).toBeInTheDocument();
    expect(screen.getByText("Escriba la superficie en hectáreas.")).toBeInTheDocument();
    expect(screen.getByText("Elija el departamento.")).toBeInTheDocument();
    expect(screen.getByText("Escriba el municipio.")).toBeInTheDocument();
  }, 20000);

  it("rejects an area that is not a positive number", async () => {
    const user = userEvent.setup();
    renderForm();
    const area = await screen.findByLabelText(/Superficie total/);
    await user.type(area, "abc");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Escriba un número, por ejemplo 4,20.")).toBeInTheDocument();
    await user.clear(area);
    await user.type(area, "0");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("La superficie tiene que ser mayor que cero.")).toBeInTheDocument();
  }, 20000);

  it("warns, without blocking, about a municipality in another department", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByLabelText(/Departamento/));
    await user.click(await screen.findByRole("option", { name: "Caldas" }));
    await user.type(screen.getByLabelText(/Municipio/), "Pitalito");
    expect(screen.getByText(/Huila/)).toBeInTheDocument();
  }, 20000);

  it("saves the plot with the coffee row already there", async () => {
    const user = userEvent.setup();
    const before = tenant().plots.length;
    renderForm();
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByDisplayValue("Café")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    expect(tenant().plots).toHaveLength(before + 1);
    const saved = tenant().plots.find((p) => p.name === "El Mirador Nuevo")!;
    expect(saved.department).toBe("Huila");
    expect(saved.areaHa).toBe(4.2);
  }, 30000);

  it("goes back to step 1 with «Atrás» and keeps what was typed", async () => {
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await user.click(await screen.findByRole("button", { name: "Atrás" }));
    expect(screen.getByDisplayValue("El Mirador Nuevo")).toBeInTheDocument();
  }, 20000);

  it("needs at least one crop", async () => {
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    await user.click(screen.getByRole("button", { name: "Quitar cultivo 1" }));
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(screen.getByText(/Agregue al menos un cultivo/)).toBeInTheDocument();
  }, 20000);

  it("adds a crop type and a variety that were typed in", async () => {
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user, "Aguacatal");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    await user.click(screen.getByRole("button", { name: "Agregar otro cultivo" }));
    const types = screen.getAllByLabelText(/Tipo de cultivo/);
    await user.type(types[1], "Aguacate Hass");
    await user.click(await screen.findByRole("option", { name: "Agregar «Aguacate Hass»" }));
    const varieties = screen.getAllByLabelText(/Variedad/);
    await user.type(varieties[1], "Méndez");
    await user.click(await screen.findByRole("option", { name: "Agregar «Méndez»" }));
    const areas = screen.getAllByLabelText(/Área \(ha\)/);
    await user.type(areas[1], "1,5");
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    expect(tenant().cropTypes.some((c) => c.name === "Aguacate Hass")).toBe(true);
    expect(tenant().varieties.some((v) => v.name === "Méndez")).toBe(true);
  }, 30000);

  it("offers the varieties already in the catalogue", async () => {
    // The server's variety catalogue carries no crop type, and the picker
    // used to require one, so no existing variety was ever offered.
    const user = userEvent.setup();
    const before = tenant().varieties.length;
    renderForm();
    await fillStep1(user, "Varietal");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    const variety = screen.getAllByLabelText(/Variedad/)[0];
    await user.click(variety);
    await user.type(variety, "Casti");
    await user.click(await screen.findByRole("option", { name: "Castillo" }));
    expect(screen.queryByRole("option", { name: /Agregar/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    // Picked, not typed in again: the catalogue did not grow.
    expect(tenant().varieties).toHaveLength(before);
    const saved = tenant().plots.find((p) => p.name === "Varietal")!;
    expect(JSON.stringify(saved)).toContain("0192f3a0-0003-7000-8000-000000000001");
  }, 30000);

  it("shows the server's error and stays on the form", async () => {
    server.use(
      http.post("*/v1/plots", () =>
        HttpResponse.json(
          { title: "Datos inválidos", status: 422, errors: [{ field: "name", message: "Ya existe un lote con ese nombre." }] },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("detalle del lote")).not.toBeInTheDocument();
  }, 20000);

  it("shows an error when the catalogues do not load", async () => {
    server.use(http.get("*/v1/catalogs/crop-types", () => HttpResponse.json({ title: "x" }, { status: 500 })));
    renderForm();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  }, 20000);

  it("goes back to the list", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByRole("button", { name: PLOT.Many }));
    expect(await screen.findByText("lista de lotes")).toBeInTheDocument();
  }, 20000);
});

describe("editing a plot", () => {
  it("loads the plot and its crops and saves the change", async () => {
    const plot = tenant().plots.find((p) => !p.deletedAt)!;
    const user = userEvent.setup();
    renderForm(`${PLOT.path}/${plot.id}/editar`);
    expect(await screen.findByText(`Modificar ${PLOT.one}`)).toBeInTheDocument();
    const name = await screen.findByDisplayValue(plot.name);
    await user.clear(name);
    await user.type(name, "Lote renombrado");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(screen.getAllByLabelText(/Tipo de cultivo/).length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: `Guardar ${PLOT.one}` }));
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    expect(tenant().plots.find((p) => p.id === plot.id)!.name).toBe("Lote renombrado");
  }, 30000);

  it("shows an error when the plot does not exist", async () => {
    renderForm(`${PLOT.path}/0192f3a0-dead-7000-8000-000000000000/editar`);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/./)).toBeInTheDocument();
  }, 20000);
});
