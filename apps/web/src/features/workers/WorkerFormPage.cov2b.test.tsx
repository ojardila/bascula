// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkerFormPage } from "./WorkerFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/empleados/nuevo" element={<WorkerFormPage />} />
            <Route path="/empleados/:id/editar" element={<WorkerFormPage />} />
            <Route path="/empleados/:id" element={<div>ficha del empleado</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
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

describe("WorkerFormPage", () => {
  it("opens a file with no phone, address, city or country as blanks and Colombia", async () => {
    const maria = db.tenantOf(db.FARM_ID)!.workers.find((w) => w.id === MARIA)!;
    maria.phone = null;
    maria.address = null;
    maria.city = null;
    maria.country = null;
    (maria as { municipality?: string | null }).municipality = null;
    renderAt(`/empleados/${MARIA}/editar`);
    await screen.findByDisplayValue(maria.name);
    expect(screen.getByLabelText(/^Teléfono/)).toHaveValue("");
    expect(screen.getByLabelText(/^Dirección/)).toHaveValue("");
    expect(screen.getByLabelText(/^Ciudad o municipio/)).toHaveValue("");
    expect(screen.getByLabelText(/^País/)).toHaveValue("Colombia");
  }, 20000);

  it("offers to reactivate without a name when the inactive file cannot be read", async () => {
    server.use(
      http.post("*/v1/workers", () =>
        HttpResponse.json(
          { error: { code: "EMPLOYEE_EXISTS_DELETED", message: "deactivated", details: { employeeId: "gone-1" } } },
          { status: 409 },
        ),
      ),
      http.get("*/v1/workers/gone-1", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await user.type(await screen.findByLabelText(/^Número de canasto/), "91");
    await user.type(screen.getByLabelText(/^Nombres/), "Otra");
    await user.type(screen.getByLabelText(/^Apellidos/), "Persona");
    await user.type(screen.getByLabelText(/^Número de identificación/), "99887766");
    await user.type(screen.getByLabelText(/^Teléfono/), "3001234567");
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
    expect(
      await screen.findByText(/Un empleado con ese documento ya está registrado y está inactivo/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver la ficha" }));
    expect(await screen.findByText("ficha del empleado")).toBeInTheDocument();
  }, 20000);

  it("shows the server's message on top when a refusal names no field", async () => {
    server.use(
      http.post("*/v1/workers", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderAt("/empleados/nuevo");
    await user.type(await screen.findByLabelText(/^Número de canasto/), "91");
    await user.type(screen.getByLabelText(/^Nombres/), "Otra");
    await user.type(screen.getByLabelText(/^Apellidos/), "Persona");
    await user.type(screen.getByLabelText(/^Número de identificación/), "99887766");
    await user.type(screen.getByLabelText(/^Teléfono/), "3001234567");
    await user.click(screen.getByRole("button", { name: /Guardar|Registrar/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("ficha del empleado")).not.toBeInTheDocument();
  }, 20000);
});
