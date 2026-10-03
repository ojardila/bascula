// SPDX-License-Identifier: MIT
/**
 * The harvest sheet's edges: switching between day and week, choosing the
 * lote, a farm without a harvest activity, and the errors on load and save.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const WEEK = "2026-08-24";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const fail = () =>
  HttpResponse.json(
    { error: { code: "INTERNAL", message: "x" } },
    { status: 500 },
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  setTokens({
    accessToken: `mock-access.${OWNER}.test`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("Planilla edges", () => {
  it("switches between the day and the week", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    expect(
      await screen.findByRole("heading", { name: "Planilla de la semana" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Por día" }));
    expect(
      await screen.findByRole("heading", { name: "Planilla del día" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText(/María Restrepo Ospina, kilos/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Semana" }));
    expect(
      await screen.findByRole("heading", { name: "Planilla de la semana" }),
    ).toBeInTheDocument();
  }, 20000);

  it("asks for the lote first, then shows its sheet", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?lunes=${WEEK}`);
    expect(
      await screen.findByText("Elija el lote de esta planilla."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: /Lote/ }));
    const listbox = await screen.findByRole("listbox");
    const alto = within(listbox)
      .getAllByRole("option")
      .find((o) => o.textContent === "El Alto")!;
    await user.click(alto);
    expect(
      await screen.findByLabelText(/María Restrepo Ospina, L 24/),
    ).toBeInTheDocument();
  }, 20000);

  it("says so when the farm has no harvest activity", async () => {
    server.use(http.get("*/v1/activities", () => HttpResponse.json([])));
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    expect(
      await screen.findByText(/no tiene una actividad de recolección/),
    ).toBeInTheDocument();
  }, 20000);

  it("shows the error when the people cannot be loaded", async () => {
    server.use(http.get("*/v1/workers", fail));
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
    expect(
      screen.queryByRole("heading", { name: "Planilla de la semana" }),
    ).not.toBeInTheDocument();
  }, 20000);

  it("shows the error when saving fails, and it can be closed", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/v1/work-records", fail));
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    const monday = await screen.findByLabelText(/María Restrepo Ospina, L 24/);
    await user.clear(monday);
    await user.type(monday, "40");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const alert = await waitFor(() => {
      const a = screen
        .getAllByRole("alert")
        .find((el) =>
          within(el).queryByRole("button", { name: /close|cerrar/i }),
        );
      expect(a).toBeTruthy();
      return a!;
    });
    await user.click(
      within(alert).getByRole("button", { name: /close|cerrar/i }),
    );
    await waitFor(() => expect(alert).not.toBeInTheDocument());
  }, 20000);

  it("goes back to the harvest", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    await user.click(
      await screen.findByRole("link", { name: "Volver a la cosecha" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Cosecha" }),
    ).toBeInTheDocument();
  }, 20000);
});
