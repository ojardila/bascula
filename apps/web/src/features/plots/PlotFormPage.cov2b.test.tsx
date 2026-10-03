// SPDX-License-Identifier: MIT
/**
 * The plot form's remaining paths: the owner's tour driving the two steps
 * (and being driven by them), its «Continuar» and «Guardar» buttons, a farm
 * with no coffee in its catalogue, a plot whose crops arrive before the
 * catalogues, a typed crop type the server already had, a new variety, an
 * empty extra row, and a point marked from the phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { delay, http, HttpResponse } from "msw";
import { PlotFormPage } from "./PlotFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { PLOT } from "../../lib/vocab";
import { api } from "../../api/endpoints";
import { TourContext, type TourContextValue } from "../onboarding/TourContext";
import { OWNER_DONE } from "../onboarding/steps";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

type Action = () => boolean | Promise<boolean>;
const actions = new Map<string, Action>();
const goTo = vi.fn();
const note = vi.fn();
const registerAction = (name: string, fn: Action) => {
  actions.set(name, fn);
  return () => {
    actions.delete(name);
  };
};

/** A tour the test can steer: `goTo` really moves it, and a button rewinds it. */
function TourHarness({ start, children }: { start: number; children: React.ReactNode }) {
  const [n, setN] = useState(start);
  const value = useMemo(
    () =>
      ({
        current: { tour: "owner", n, def: {} },
        paused: false,
        isAt: () => false,
        goTo: (k: number) => {
          goTo(k);
          setN(k);
        },
        note,
        registerAction,
      }) as unknown as TourContextValue,
    [n],
  );
  return (
    <TourContext.Provider value={value}>
      <button type="button" onClick={() => setN(9)}>
        tour back to 9
      </button>
      <span data-testid="tour-step">{n}</span>
      {children}
    </TourContext.Provider>
  );
}

function renderForm(path = `${PLOT.path}/nuevo`, tourAt?: number) {
  const routes = (
    <Routes>
      <Route path={`${PLOT.path}/nuevo`} element={<PlotFormPage />} />
      <Route path={`${PLOT.path}/:id/editar`} element={<PlotFormPage />} />
      <Route path={`${PLOT.path}/:id`} element={<p>detalle del lote</p>} />
    </Routes>
  );
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          {tourAt === undefined ? routes : <TourHarness start={tourAt}>{routes}</TourHarness>}
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function fillStep1(user: ReturnType<typeof userEvent.setup>, name = "Lote nuevo") {
  await user.type(screen.getByLabelText(/Nombre del lote/), name);
  await user.type(screen.getByLabelText(/Superficie total/), "4,20");
  await user.click(screen.getByLabelText(/Departamento/));
  await user.click(await screen.findByRole("option", { name: "Huila" }));
  await user.type(screen.getByLabelText(/Municipio/), "Pitalito");
}

const save = () => screen.getByRole("button", { name: `Guardar ${PLOT.one}` });

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  actions.clear();
  goTo.mockClear();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "geolocation");
});

describe("the owner's tour on a new plot", () => {
  it("follows the steps both ways and finishes on save", async () => {
    const user = userEvent.setup();
    renderForm(undefined, 9);
    await fillStep1(user, "Tour");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    expect(goTo).toHaveBeenLastCalledWith(10);

    // The tour went back a step on its own: the form follows it.
    await user.click(screen.getByRole("button", { name: "tour back to 9" }));
    expect(await screen.findByLabelText(/Nombre del lote/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    expect(screen.getByTestId("tour-step")).toHaveTextContent("10");

    // The form went back a step: the tour follows it.
    await user.click(screen.getByRole("button", { name: "Atrás" }));
    await waitFor(() => expect(screen.getByTestId("tour-step")).toHaveTextContent("9"));

    // The tour's own «Continuar» and «Guardar».
    let ok = false;
    await waitFor(async () => {
      ok = await actions.get("plot-next")!();
      expect(ok).toBe(true);
    });
    await screen.findByDisplayValue("Café");
    await waitFor(() => expect(screen.getByTestId("tour-step")).toHaveTextContent("10"));
    await waitFor(async () => expect(await actions.get("plot-save")!()).toBe(true));
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    expect(goTo).toHaveBeenLastCalledWith(OWNER_DONE);
    expect(note).toHaveBeenCalledWith({ plot: "Tour" });
  }, 40000);

  it("the tour's «Continuar» refuses an empty first step", async () => {
    renderForm(undefined, 9);
    await screen.findByLabelText(/Nombre del lote/);
    await waitFor(() => expect(actions.has("plot-next")).toBe(true));
    expect(await actions.get("plot-next")!()).toBe(false);
    expect(await screen.findByText("Escriba el nombre del lote.")).toBeInTheDocument();
  }, 20000);
});

describe("catalogues", () => {
  it("starts with an empty row when the farm grows no coffee", async () => {
    server.use(
      http.get("*/v1/catalogs/crop-types", () =>
        HttpResponse.json({ items: [{ id: "0192f3a0-0002-7000-8000-000000000004", name: "Yuca" }], nextCursor: null }),
      ),
    );
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    const [type] = await screen.findAllByLabelText(/Tipo de cultivo/);
    expect(type).toHaveValue("");
  }, 20000);

  it("uses the crop type the server already had for a typed-in name", async () => {
    const cafe = tenant().cropTypes[0];
    server.use(http.post("*/v1/catalogs/crop-types", () => HttpResponse.json(cafe)));
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user, "Tipeado");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    await user.click(screen.getByRole("button", { name: "Quitar cultivo 1" }));
    await user.click(screen.getByRole("button", { name: "Agregar otro cultivo" }));
    await user.type(screen.getByLabelText(/Tipo de cultivo/), "Cafe arábigo");
    await user.click(await screen.findByRole("option", { name: "Agregar «Cafe arábigo»" }));
    await user.click(save());
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    const plot = tenant().plots.find((p) => p.name === "Tipeado")!;
    expect(plot.crops[0].cropTypeId).toBe(cafe.id);
  }, 30000);
});

describe("editing", () => {
  it("keeps crops that arrive before the catalogues, adds a new variety and skips an empty row", async () => {
    const alto = tenant().plots.find((p) => p.id === ALTO)!;
    alto.crops[0].variety = null; // an id with no name
    alto.crops[1].varietyId = null;
    alto.crops[1].variety = null;
    server.use(
      http.get("*/v1/catalogs/crop-types", async () => {
        await delay(150);
        return HttpResponse.json({ items: tenant().cropTypes, nextCursor: null });
      }),
    );
    const user = userEvent.setup();
    renderForm(`${PLOT.path}/${ALTO}/editar`);
    await screen.findByDisplayValue("El Alto");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(screen.getAllByLabelText(/Tipo de cultivo/)).toHaveLength(2));
    // The catalogues arriving later did not replace the plot's own rows.
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getAllByLabelText(/Tipo de cultivo/)).toHaveLength(2);
    const varieties = screen.getAllByLabelText(/Variedad/);
    expect(varieties[0]).toHaveValue("");
    expect(varieties[1]).toHaveValue("");

    await user.type(varieties[1], "Tabi");
    await user.click(await screen.findByRole("option", { name: "Agregar «Tabi»" }));

    await user.click(screen.getByRole("button", { name: "Agregar otro cultivo" }));
    expect(screen.getAllByLabelText(/Tipo de cultivo/)).toHaveLength(3);
    await user.click(save());
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    const saved = tenant().plots.find((p) => p.id === ALTO)!;
    expect(saved.crops.filter((c) => !c.deletedAt)).toHaveLength(2);
    expect(tenant().varieties.some((v) => v.name === "Tabi")).toBe(true);
  }, 40000);

  it("saves a point marked from the phone", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({
            coords: { latitude: 2.2, longitude: -76.1, accuracy: 5 } as GeolocationCoordinates,
            timestamp: Date.now(),
          } as GeolocationPosition),
      },
    });
    const update = vi.spyOn(api, "updatePlot");
    const user = userEvent.setup();
    renderForm(`${PLOT.path}/0192f3a0-0004-7000-8000-000000000002/editar`);
    await screen.findByDisplayValue("La Cuchilla");
    await user.click(screen.getByRole("button", { name: "Estoy parado en el lote" }));
    expect(await screen.findByText("2.20000, -76.10000")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(screen.getAllByLabelText(/Tipo de cultivo/).length).toBeGreaterThan(0));
    await user.click(save());
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
    expect(update.mock.calls[0][1].location).toEqual({
      type: "Point",
      coordinates: [-76.1, 2.2],
    });
  }, 30000);
});
