/**
 * The rest of the worker form: editing somebody who is already on the farm,
 * what it says before it lets an incomplete file through, and what it does
 * when the server says no for a reason it cannot fix by itself.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkerFormPage } from "./WorkerFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/nuevo" element={<WorkerFormPage />} />
            <Route path="/empleados/:id/editar" element={<WorkerFormPage />} />
            <Route
              path="/empleados/:id/equipo"
              element={<div>ficha del equipo</div>}
            />
            <Route
              path="/empleados/:id"
              element={<div>ficha del empleado</div>}
            />
            <Route path="/empleados" element={<div>lista de empleados</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function maria() {
  return db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === MARIA)!;
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

describe("editing somebody already on the farm", () => {
  it("opens with their file filled in and saves what was changed", async () => {
    const user = userEvent.setup();
    renderAt(`/empleados/${MARIA}/editar`);
    expect(
      await screen.findByRole("heading", { name: "Modificar empleado" }),
    ).toBeInTheDocument();
    const nameBox = screen.getByLabelText(/^Nombres/);
    await waitFor(() => expect(nameBox).toHaveValue(maria().name));
    expect(screen.getByLabelText(/^Número de canasto/)).toHaveValue(
      maria().tag,
    );

    await user.clear(screen.getByLabelText(/^Dirección/));
    await user.type(screen.getByLabelText(/^Dirección/), "Vereda La Esperanza");
    await user.clear(screen.getByLabelText(/^Ciudad o municipio/));
    await user.type(screen.getByLabelText(/^Ciudad o municipio/), "Pitalito");
    await user.clear(screen.getByLabelText(/^País/));
    await user.type(screen.getByLabelText(/^País/), "Ecuador");
    if (!(screen.getByLabelText(/^Teléfono/) as HTMLInputElement).value) {
      await user.type(screen.getByLabelText(/^Teléfono/), "3001234567");
    }
    await user.click(screen.getByLabelText(/^Tipo de identificación/));
    await user.click(await screen.findByRole("option", { name: "Pasaporte" }));
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));

    expect(await screen.findByText("ficha del empleado")).toBeInTheDocument();
    expect(maria().address).toBe("Vereda La Esperanza");
    expect(maria().city).toBe("Pitalito");
    expect(maria().country).toBe("Ecuador");
    expect(maria().documentType).toBe("PAS");
  }, 30000);

  it("sends a team to the team's own page instead of this form", async () => {
    await api.createWorker({
      id: "0192f3a0-0006-7000-8000-0000000000e1",
      name: "Cuadrilla Norte",
      tag: "40",
      kind: "equipo",
      memberIds: [JHON, LUZ],
    } as never);
    invalidateRefs();
    renderAt("/empleados/0192f3a0-0006-7000-8000-0000000000e1/editar");
    expect(await screen.findByText("ficha del equipo")).toBeInTheDocument();
  }, 20000);

  it("says so when the person cannot be loaded", async () => {
    renderAt("/empleados/0192f3a0-0006-7000-8000-0000000000ff/editar");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  }, 20000);

  it("lets somebody from before the basket rule be saved without a number", async () => {
    const w = maria();
    w.tag = null as never;
    if (!w.phone) w.phone = "3001234567";
    const user = userEvent.setup();
    renderAt(`/empleados/${MARIA}/editar`);
    expect(
      await screen.findByText(
        "Esta persona todavía no tiene número de canasto. Escríbalo aquí.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Nombres/)).toHaveValue(w.name),
    );
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
    expect(await screen.findByText("ficha del empleado")).toBeInTheDocument();
    expect(maria().tag ?? null).toBeNull();
  }, 20000);
});

describe("before anything is sent", () => {
  it("asks for each missing piece in plain words", async () => {
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await user.click(
      await screen.findByRole("button", { name: /Guardar|Registrar/ }),
    );
    expect(await screen.findByText("Escriba el nombre.")).toBeInTheDocument();
    expect(screen.getByText("Escriba los apellidos.")).toBeInTheDocument();
    expect(
      screen.getByText("Escriba el número de identificación."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Escriba un teléfono de contacto."),
    ).toBeInTheDocument();
  }, 20000);

  it("refuses a phone with letters in it", async () => {
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await user.type(await screen.findByLabelText(/^Teléfono/), "llámeme");
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
    expect(
      await screen.findByText("Escriba solo números, con o sin indicativo."),
    ).toBeInTheDocument();
  }, 20000);

  it("goes back to the list from either button", async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt("/empleados/nuevo");
    await user.click(await screen.findByRole("button", { name: "Empleados" }));
    expect(await screen.findByText("lista de empleados")).toBeInTheDocument();
    unmount();
    renderAt("/empleados/nuevo");
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("lista de empleados")).toBeInTheDocument();
  }, 20000);
});

describe("when the server says no", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(/^Número de canasto/), "91");
    await user.type(screen.getByLabelText(/^Nombres/), "Otra");
    await user.type(screen.getByLabelText(/^Apellidos/), "Persona");
    await user.type(
      screen.getByLabelText(/^Número de identificación/),
      "99887766",
    );
    await user.type(screen.getByLabelText(/^Teléfono/), "3001234567");
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
  }

  it("puts field errors under their boxes and the message on top", async () => {
    server.use(
      http.post("*/v1/workers", () =>
        HttpResponse.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "invalid",
              details: { fields: { name: "Ese nombre no sirve." } },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await fill(user);
    expect(await screen.findByText("Ese nombre no sirve.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("ficha del empleado")).not.toBeInTheDocument();
  }, 20000);

  it("offers to reactivate even when it cannot say who it is", async () => {
    server.use(
      http.post("*/v1/workers", () =>
        HttpResponse.json(
          {
            error: {
              code: "EMPLOYEE_EXISTS_DELETED",
              message: "deactivated",
              details: {},
            },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await fill(user);
    expect(
      await screen.findByText(
        /Un empleado con ese documento ya está registrado y está inactivo/,
      ),
    ).toBeInTheDocument();
    // Without an id there is nobody to reactivate: the button does nothing.
    await user.click(screen.getByRole("button", { name: "Reactivar" }));
    expect(screen.queryByText("ficha del empleado")).not.toBeInTheDocument();
  }, 20000);

  it("opens the existing file, or reports a failed reactivation", async () => {
    const t = db.tenantOf(db.FARM_ID)!;
    const gone = t.workers.find((x) => x.docId && x.id !== MARIA)!;
    gone.deletedAt = new Date().toISOString();
    server.use(
      http.patch("*/v1/workers/:id", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await user.type(await screen.findByLabelText(/^Número de canasto/), "91");
    await user.type(screen.getByLabelText(/^Nombres/), "Otra");
    await user.type(screen.getByLabelText(/^Apellidos/), "Persona");
    await user.type(
      screen.getByLabelText(/^Número de identificación/),
      gone.docId!,
    );
    await user.type(screen.getByLabelText(/^Teléfono/), "3001234567");
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
    await user.click(await screen.findByRole("button", { name: "Reactivar" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Esa identificación ya existe en la finca"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Submitting again brings the offer back, and «Ver la ficha» opens it.
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
    await user.click(
      await screen.findByRole("button", { name: "Ver la ficha" }),
    );
    expect(await screen.findByText("ficha del empleado")).toBeInTheDocument();
  }, 30000);
});
