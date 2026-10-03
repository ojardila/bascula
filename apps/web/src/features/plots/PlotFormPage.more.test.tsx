/**
 * The plot form, the paths `PlotFormPage.test.tsx` leaves out: a name that is
 * too long, the server pointing at a field, and editing a plot whose crop has
 * a variety but no declared area, including its planting date.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function renderForm(path = `${PLOT.path}/nuevo`) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path={`${PLOT.path}/nuevo`} element={<PlotFormPage />} />
            <Route
              path={`${PLOT.path}/:id/editar`}
              element={<PlotFormPage />}
            />
            <Route
              path={`${PLOT.path}/:id`}
              element={<p>detalle del lote</p>}
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function fillStep1(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.type(screen.getByLabelText(/Nombre del lote/), name);
  await user.type(screen.getByLabelText(/Superficie total/), "4,20");
  await user.click(screen.getByLabelText(/Departamento/));
  await user.click(await screen.findByRole("option", { name: "Huila" }));
  await user.type(screen.getByLabelText(/Municipio/), "Pitalito");
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

describe("step 1", () => {
  it("refuses a name longer than 80 characters", async () => {
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user, "L");
    // The field caps typing at 80; a pasted or restored value may not be.
    fireEvent.change(screen.getByLabelText(/Nombre del lote/), {
      target: { value: "L".repeat(81) },
    });
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(
      await screen.findByText("Máximo 80 caracteres."),
    ).toBeInTheDocument();
  }, 20000);
});

describe("the server pointing at a field", () => {
  it("keeps the form and shows what it said", async () => {
    server.use(
      http.post("*/v1/plots", () =>
        HttpResponse.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Revise los datos",
              details: {
                fields: { name: "Ya existe un lote con ese nombre." },
              },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderForm();
    await fillStep1(user, "El Alto Dos");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByDisplayValue("Café");
    await user.click(
      screen.getByRole("button", { name: `Guardar ${PLOT.one}` }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(screen.queryByText("detalle del lote")).not.toBeInTheDocument();
  }, 20000);
});

describe("editing a plot", () => {
  it("loads a crop with its variety and no area, and takes a new planting date", async () => {
    const crop = tenant().plots.find((p) => p.id === ALTO)!.crops[0];
    crop.areaHa = null;
    crop.plantedOn = null;
    const user = userEvent.setup();
    renderForm(`${PLOT.path}/${ALTO}/editar`);
    await waitFor(() =>
      expect(screen.getByLabelText(/Nombre del lote/)).toHaveValue("El Alto"),
    );
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByDisplayValue("Castillo")).toBeInTheDocument();
    const [planted] = screen.getAllByLabelText(/^Siembra/);
    await user.type(planted, "15/04/2022");
    expect(screen.getByText("viernes 15 de abril de 2022")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: `Guardar ${PLOT.one}` }),
    );
    expect(await screen.findByText("detalle del lote")).toBeInTheDocument();
  }, 20000);
});
