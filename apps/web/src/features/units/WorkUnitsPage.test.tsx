/**
 * The farm's units, and the one thing this screen must never do.
 *
 * "Precio del kilo es muy especifico no siempre tendremos la misma unidad
 * ademas no hay forma de borrar o edidtar". Units could be created and listed
 * and nothing else since migration 00004.
 *
 * What is asserted is not that the buttons exist. It is that the screen tells
 * the truth about what removing does: a unit no record points at is deleted, a
 * unit that history points at is RETIRED -- destroying it would leave a row
 * saying "40" of something nobody can name, in the row that decided a picker's
 * pay. The screen says which will happen before the press, and which happened
 * after.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { WorkUnitsPage } from "./WorkUnitsPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderApp(_path?: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/unidades"]}>
        <AuthProvider>
          <WorkUnitsPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("units of collection", () => {
  beforeEach(() => {
    db.resetDb();
    invalidateRefs();
    const now = Date.now();
    setTokens({
      accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
      refreshToken: `mock-refresh.${OWNER}`,
    });
  });

  it("lists what the farm counts in, and what each one weighs", async () => {
    renderApp("/unidades");
    expect(await screen.findByText("Kilo")).toBeTruthy();
    expect(await screen.findByText("Canasta")).toBeTruthy();
    // The factor is said as a sentence, not as a bare number to interpret.
    expect(await screen.findByText(/1 kilo = 1 kg/i)).toBeTruthy();
    // A unit that does not convert says so rather than showing an empty cell.
    expect(await screen.findByText(/No se convierte a kilos/i)).toBeTruthy();
  });

  it("warns that a unit already used will be RETIRED, not deleted", async () => {
    const user = userEvent.setup();
    renderApp("/unidades");
    await user.click(await screen.findByRole("button", { name: /Quitar Kilo/i }));

    // The kilo is referenced by the seeded activities. The dialog must not
    // offer to delete it.
    expect(await screen.findByText(/se guarda en el historial/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Guardar en el historial/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Borrar$/i })).toBeNull();
  });

  it("offers a real deletion only for a unit nobody used", async () => {
    const user = userEvent.setup();
    renderApp("/unidades");
    await user.click(await screen.findByRole("button", { name: /Quitar Canasta/i }));

    expect(await screen.findByText(/se borra/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Borrar$/i })).toBeTruthy();
  });

  it("says which of the two actually happened", async () => {
    const user = userEvent.setup();
    renderApp("/unidades");
    await user.click(await screen.findByRole("button", { name: /Quitar Kilo/i }));
    await user.click(screen.getByRole("button", { name: /Guardar en el historial/i }));

    // Not "se borró". Reporting a deletion that was a retirement is the lie
    // this screen exists to avoid.
    await waitFor(() =>
      expect(screen.getByText(/se guardó en el historial/i)).toBeTruthy(),
    );
  });

  it("a mistyped unit can be corrected", async () => {
    const user = userEvent.setup();
    renderApp("/unidades");
    await user.click(await screen.findByRole("button", { name: /Editar Canasta/i }));

    const name = await screen.findByLabelText(/Cómo se llama/i);
    await user.clear(name);
    await user.type(name, "Canastilla");
    await user.click(screen.getByRole("button", { name: /^Guardar$/i }));

    await waitFor(() => expect(screen.getByText(/quedó guardada/i)).toBeTruthy());
    expect(await screen.findByText("Canastilla")).toBeTruthy();
  });

  it("refuses a weight that is not a number above zero", async () => {
    const user = userEvent.setup();
    renderApp("/unidades");
    await user.click(await screen.findByRole("button", { name: /Editar Canasta/i }));

    const factor = await screen.findByLabelText(/Cuántos kilos pesa una/i);
    await user.type(factor, "0");
    expect(await screen.findByText(/mayor que cero/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Guardar$/i }).hasAttribute("disabled")).toBe(true);
  });
});
