// SPDX-License-Identifier: MIT
/**
 * «Registrar labor» with signal: saving one, saving one and staying for the
 * next, filtering the activities, and what it says when the server refuses.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkRecordFormPage } from "./WorkRecordFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function renderForm() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/labores/nueva"]}>
        <AuthProvider>
          <Routes>
            <Route path="/labores/nueva" element={<WorkRecordFormPage />} />
            <Route path="/labores" element={<div>lista de labores</div>} />
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

type User = ReturnType<typeof userEvent.setup>;

async function pickActivity(user: User, name: string) {
  await user.click(await screen.findByLabelText(/^Actividad/));
  await user.click(await screen.findByRole("option", { name }));
}

async function fillRest(user: User, who: RegExp, lote: string, qty: string) {
  await user.click(screen.getByLabelText(/^Empleado/));
  await user.click(await screen.findByRole("option", { name: who }));
  await user.click(screen.getByLabelText(/^Lotes/));
  await user.click(await screen.findByRole("option", { name: lote }));
  await user.keyboard("{Escape}");
  await user.click(screen.getByLabelText(/^Cultivos/));
  const crops = await screen.findAllByRole("option", {
    name: (name) => name.startsWith(`${lote} · `),
  });
  await user.click(crops[0]);
  await user.keyboard("{Escape}");
  await user.type(
    screen.getByLabelText(/^Cantidad|^Jornales|^Días|^Horas/),
    qty,
  );
}

describe("saving a labor", () => {
  it("records it and goes back to the list", async () => {
    const before = tenant().workRecords.length;
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Guadañada");
    await fillRest(user, /María/, "El Alto", "2");
    await user.type(screen.getByLabelText(/^Nota/), "Ronda del lunes");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("lista de labores")).toBeInTheDocument();
    expect(tenant().workRecords).toHaveLength(before + 1);
  }, 30000);

  it("«Guardar y registrar otra» keeps the activity and clears the person", async () => {
    const before = tenant().workRecords.length;
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Guadañada");
    await fillRest(user, /María/, "El Alto", "1");
    await user.click(
      screen.getByRole("button", { name: "Guardar y registrar otra" }),
    );
    expect(
      await screen.findByText("Labor guardada. Puede registrar la siguiente."),
    ).toBeInTheDocument();
    expect(tenant().workRecords).toHaveLength(before + 1);
    expect(screen.getByLabelText(/^Empleado/)).toHaveValue("");
  }, 30000);

  it("lets the owner change the price of a contract", async () => {
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Siembra de colinos");
    const price = await screen.findByLabelText(/^Valor del contrato/);
    expect(price).toHaveValue("1200000");
    expect(
      screen.getByText("Por defecto, el de la actividad."),
    ).toBeInTheDocument();
    await user.clear(price);
    await user.type(price, "900000");
    expect(price).toHaveValue("900000");
  }, 30000);

  it("filters the activities by category", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByLabelText(/^Categoría/));
    await user.click(await screen.findByRole("option", { name: "Siembra" }));
    await user.click(screen.getByLabelText(/^Actividad/));
    expect(
      await screen.findByRole("option", { name: "Siembra de colinos" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Guadañada" }),
    ).not.toBeInTheDocument();
  }, 30000);

  it("shows the server's reason when it refuses", async () => {
    server.use(
      http.post("*/v1/work-records", () =>
        HttpResponse.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "invalid",
              details: { fields: { quantity: "Demasiados jornales." } },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderForm();
    await pickActivity(user, "Guadañada");
    await fillRest(user, /María/, "El Alto", "2");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Demasiados jornales.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("lista de labores")).not.toBeInTheDocument();
  }, 30000);

  it("goes back to the list from either button", async () => {
    const user = userEvent.setup();
    const { unmount } = renderForm();
    await user.click(await screen.findByRole("button", { name: "Labores" }));
    expect(await screen.findByText("lista de labores")).toBeInTheDocument();
    unmount();
    renderForm();
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("lista de labores")).toBeInTheDocument();
  }, 30000);
});

describe("when the lists do not load", () => {
  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/activities", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderForm();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Registrar labor" }),
      ).not.toBeInTheDocument(),
    );
  }, 20000);

  it("says what failed on a server error", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    renderForm();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  }, 20000);
});
