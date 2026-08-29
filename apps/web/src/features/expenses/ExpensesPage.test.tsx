/**
 * The gastos module, with `expense_target` under test from the interface side.
 *
 * The constraint is
 *
 *     (activity_id IS NOT NULL) + (COALESCE(plot_id, plot_crop_id) IS NOT NULL) = 1
 *
 * and the design decision is that the form must make BOTH failures unreachable
 * rather than merely refuse them: charged to two things, and charged to
 * nothing. So most of what is asserted here is what the screen does NOT offer.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ExpensesPage } from "./ExpensesPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { resetDb, FARM_ID } from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderExpenses() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/gastos"]}>
        <AuthProvider>
          <ExpensesPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("a gasto is charged to one thing, and the form cannot say otherwise", () => {
  it("offers activity OR lot, never both at once", async () => {
    const user = userEvent.setup();
    renderExpenses();
    await screen.findByText("Abono para el lote El Alto");

    await user.click(screen.getByRole("button", { name: "Registrar gasto" }));
    const dialog = await screen.findByRole("dialog");

    // "Actividad" is the starting choice, so the activity select is there and
    // the lot select simply does not exist — not disabled, ABSENT, so there is
    // nothing holding a value that could travel with the request.
    expect(within(dialog).getByRole("radio", { name: "Actividad" })).toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: /^Actividad/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /^Lote/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("radio", { name: "Lote / cultivo" }));

    // And the other way round.
    expect(within(dialog).getByRole("combobox", { name: /^Lote/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /^Actividad/ })).not.toBeInTheDocument();
  }, 20000);

  it("has no way to charge a gasto to nothing", async () => {
    const user = userEvent.setup();
    renderExpenses();
    await screen.findByText("Abono para el lote El Alto");

    await user.click(screen.getByRole("button", { name: "Registrar gasto" }));
    const dialog = await screen.findByRole("dialog");

    // There is no empty option in the radio group — one of the two is always
    // chosen — and leaving its select blank is refused with a sentence that
    // says what to pick.
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.some((r) => (r as HTMLInputElement).checked)).toBe(true);

    await user.type(within(dialog).getByLabelText(/En qué se gastó/), "Cuerda de nailon");
    await user.type(within(dialog).getByLabelText(/^Valor/), "60000");
    await user.click(within(dialog).getByRole("button", { name: "Guardar gasto" }));

    expect(await within(dialog).findByText(/Elija a qué actividad se carga/))
      .toBeInTheDocument();
  }, 20000);

  it("records one charged to a lot, and shows what it was charged to", async () => {
    const user = userEvent.setup();
    renderExpenses();
    await screen.findByText("Abono para el lote El Alto");

    await user.click(screen.getByRole("button", { name: "Registrar gasto" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/En qué se gastó/), "Arreglo de la cerca");
    await user.type(within(dialog).getByLabelText(/^Valor/), "300000");
    await user.click(within(dialog).getByRole("radio", { name: "Lote / cultivo" }));
    await user.click(within(dialog).getByRole("combobox", { name: /^Lote/ }));
    await user.click(await screen.findByRole("option", { name: "El Alto" }));
    await user.click(within(dialog).getByRole("button", { name: "Guardar gasto" }));

    expect(await screen.findByText("Arreglo de la cerca")).toBeInTheDocument();
    // The "Se carga a" column is what makes it possible to notice that
    // everything for three weeks went to whatever was first in the select.
    const row = screen.getByText("Arreglo de la cerca").closest("tr")!;
    expect(within(row).getByText("El Alto")).toBeInTheDocument();
  }, 30000);

  it("lets a lot expense cover the whole lot, with no crop", async () => {
    const user = userEvent.setup();
    renderExpenses();
    await screen.findByText("Abono para el lote El Alto");

    await user.click(screen.getByRole("button", { name: "Registrar gasto" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Lote / cultivo" }));
    // "Todo el lote" is a real option, because a fence repair belongs to the
    // lot and not to the coffee in half of it.
    await user.click(within(dialog).getByRole("combobox", { name: /^Lote/ }));
    await user.click(await screen.findByRole("option", { name: "El Alto" }));
    await user.click(within(dialog).getByRole("combobox", { name: /^Cultivo/ }));
    expect(await screen.findByRole("option", { name: "Todo el lote" })).toBeInTheDocument();
  }, 20000);
});

describe("the list", () => {
  it("shows the total the server summed, not the one the browser could add up", async () => {
    renderExpenses();
    // Four live expenses in the seed: 1.250.000 + 180.000 + 420.000 + 350.000.
    expect(await screen.findByText(/4 gasto\(s\), por un total de/)).toBeInTheDocument();
    expect(screen.getByText("$2.200.000")).toBeInTheDocument();
  }, 20000);

  it("keeps a gasto that was taken out of service, rather than deleting it", async () => {
    const user = userEvent.setup();
    renderExpenses();
    await screen.findByText("Abono para el lote El Alto");
    expect(screen.queryByText("Alquiler de motobomba")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    await waitFor(() =>
      expect(screen.getByText("Alquiler de motobomba")).toBeInTheDocument(),
    );
  }, 20000);

  it("says out loud that this is not a worker's debt", async () => {
    const user = userEvent.setup();
    renderExpenses();
    await screen.findByText("Abono para el lote El Alto");
    await user.click(screen.getByRole("button", { name: "Registrar gasto" }));
    const dialog = await screen.findByRole("dialog");
    // RSP-030 and RSP-007 both say "gasto" and mean different things. Recording
    // the cost of a spraying must not take money out of anybody's wages.
    expect(within(dialog).getByText(/descontarle algo a un\s+empleado/)).toBeInTheDocument();
  }, 20000);
});
