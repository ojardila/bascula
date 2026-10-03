// SPDX-License-Identifier: MIT
/**
 * The harvest sheet's remaining paths: a farm with a single lote picks it by
 * itself, the day and week pickers, a day in the future that is refused, the
 * success message that closes, and a screen opened before the session is in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { PlanillaPage } from "./PlanillaPage";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const WEEK = "2026-08-24";

/** The address bar, where the sheet keeps its day, week and lote. */
function Spy() {
  return <output data-testid="search">{useLocation().search}</output>;
}
const search = () => screen.getByTestId("search").textContent ?? "";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
          <Spy />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** Leave the farm with El Alto as its only live lote. */
function onlyAlto() {
  const t = db.tenantOf(db.FARM_ID)!;
  for (const p of t.plots) {
    if (p.id !== ALTO) p.deletedAt = "2026-01-01T00:00:00Z";
  }
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  setTokens({
    accessToken: `mock-access.${OWNER}.test`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("Planilla with a single lote", () => {
  it("picks it by itself on the day sheet", async () => {
    onlyAlto();
    renderApp("/labores/planilla?modo=dia");
    expect(
      await screen.findByRole("heading", { name: "Planilla del día" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(search()).toContain(`lote=${ALTO}`));
    expect(search()).toContain("dia=");
  });

  it("picks it by itself on the week sheet", async () => {
    onlyAlto();
    renderApp(`/labores/planilla?modo=semana&lunes=${WEEK}`);
    expect(
      await screen.findByRole("heading", { name: "Planilla de la semana" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(search()).toContain(`lote=${ALTO}`));
    expect(search()).toContain(`lunes=${WEEK}`);
  });
});

describe("Planilla pickers", () => {
  it("goes from a day with no date to this week", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?modo=dia&lote=${ALTO}`);
    await screen.findByRole("heading", { name: "Planilla del día" });
    await user.click(screen.getByRole("tab", { name: "Semana" }));
    expect(
      await screen.findByRole("heading", { name: "Planilla de la semana" }),
    ).toBeInTheDocument();
    expect(search()).toMatch(/lunes=\d{4}-\d{2}-\d{2}/);
    expect(search()).toContain(`lote=${ALTO}`);
  });

  it("moves the week, and ignores an emptied field", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    await screen.findByRole("heading", { name: "Planilla de la semana" });
    const field = screen.getByLabelText("Semana", { selector: "input" });
    await user.clear(field);
    expect(search()).toContain(`lunes=${WEEK}`);
    await user.click(field);
    await user.paste("02/09/2026");
    await waitFor(() => expect(search()).toContain("lunes=2026-08-31"));
    expect(
      await screen.findByText(/Semana del/),
    ).toBeInTheDocument();
  });

  it("moves the day, refuses one in the future and ignores an empty one", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?modo=dia&dia=2026-08-25&lote=${ALTO}`);
    await screen.findByRole("heading", { name: "Planilla del día" });
    const field = screen.getByLabelText("Día", { selector: "input" });
    await user.clear(field);
    expect(search()).toContain("dia=2026-08-25");
    await user.click(field);
    await user.paste("01/01/2099");
    expect(search()).toContain("dia=2026-08-25");
    await user.clear(field);
    await user.click(field);
    await user.paste("26/08/2026");
    await waitFor(() => expect(search()).toContain("dia=2026-08-26"));
  });

  it("says the sheet was saved, and the message closes", async () => {
    const user = userEvent.setup();
    renderApp(`/labores/planilla?lunes=${WEEK}&lote=${ALTO}`);
    const monday = await screen.findByLabelText(/María Restrepo Ospina, L 24/);
    await user.clear(monday);
    await user.type(monday, "41");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const ok = await waitFor(() => {
      const a = screen
        .getAllByRole("alert")
        .find((el) => el.className.includes("Success"));
      expect(a).toBeTruthy();
      return a!;
    });
    await user.click(within(ok).getByRole("button", { name: /close|cerrar/i }));
    await waitFor(() => expect(ok).not.toBeInTheDocument());
  });
});

describe("Planilla before the session is in", () => {
  it("shows nothing it may not until the user is known", async () => {
    signInOwner();
    renderWithAuth(<PlanillaPage />, { path: `/?lunes=${WEEK}&lote=${ALTO}` });
    // On the first frame there is no user yet, so no permission either.
    expect(
      screen.getByText(/registrar la planilla de recolección/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Planilla de la semana" }),
    ).toBeInTheDocument();
  });
});
