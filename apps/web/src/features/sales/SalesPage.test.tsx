/**
 * The ventas module.
 *
 * The thing worth testing here is the seam between two modules: a sale is not
 * only a row in a list, it is product leaving a warehouse. So the cases below
 * follow the quantity — into the warning before the sale, out of the stock
 * after it, and back again when the sale is voided.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SalesPage } from "./SalesPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { resetDb, FARM_ID } from "../../mocks/db";
import { api } from "../../api/endpoints";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const PERGAMINO = "0192f3a0-0011-7000-8000-000000000001";

function renderSales() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/ventas"]}>
        <AuthProvider>
          <SalesPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function fillSale(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  { qty, amount }: { qty: string; amount: string },
) {
  await user.click(within(dialog).getByRole("combobox", { name: /^Producto/ }));
  await user.click(await screen.findByRole("option", { name: /Café pergamino seco/ }));
  await user.click(within(dialog).getByRole("combobox", { name: /Bodega de la que sale/ }));
  await user.click(await screen.findByRole("option", { name: "Bodega principal" }));
  await user.type(within(dialog).getByLabelText(/^Cantidad/), qty);
  await user.type(within(dialog).getByLabelText(/^Valor total/), amount);
}

beforeEach(() => {
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("a sale is product leaving a warehouse", () => {
  it("records it and takes the product out of the bodega", async () => {
    const user = userEvent.setup();
    const before = (await api.listProducts()).find((p) => p.id === PERGAMINO)!;
    expect(before.stock).toBe(28);

    renderSales();
    await screen.findByRole("heading", { name: "Ventas" });
    await user.click(screen.getByRole("button", { name: "Registrar venta" }));
    const dialog = await screen.findByRole("dialog");
    await fillSale(user, dialog, { qty: "4", amount: "4800000" });
    await user.click(within(dialog).getByRole("button", { name: "Registrar venta" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const after = (await api.listProducts()).find((p) => p.id === PERGAMINO)!;
    expect(after.stock).toBe(24);
  }, 30000);

  it("shows what a unit works out at, so a misplaced zero is visible", async () => {
    const user = userEvent.setup();
    renderSales();
    await screen.findByRole("heading", { name: "Ventas" });
    await user.click(screen.getByRole("button", { name: "Registrar venta" }));
    const dialog = await screen.findByRole("dialog");
    await fillSale(user, dialog, { qty: "4", amount: "4800000" });
    expect(within(dialog).getByText("$1.200.000 por bulto")).toBeInTheDocument();
  }, 30000);

  it("warns before the server has to, and takes the override", async () => {
    const user = userEvent.setup();
    renderSales();
    await screen.findByRole("heading", { name: "Ventas" });
    await user.click(screen.getByRole("button", { name: "Registrar venta" }));
    const dialog = await screen.findByRole("dialog");
    await fillSale(user, dialog, { qty: "999", amount: "100000" });

    expect(await within(dialog).findByText(/La bodega dice que solo hay/)).toBeInTheDocument();

    // Refused while the box is unticked...
    await user.click(within(dialog).getByRole("button", { name: "Registrar venta" }));
    expect(await within(dialog).findByText(/No hay tanto en esa bodega/)).toBeInTheDocument();

    // ...and recorded once somebody has said they know.
    await user.click(
      within(dialog).getByRole("checkbox", { name: /Regístrela de todos modos/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Registrar venta" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }, 30000);
});

describe("undoing a sale", () => {
  it("anula rather than deletes, and puts the product back", async () => {
    const user = userEvent.setup();
    renderSales();
    await screen.findByText("Café pergamino seco");

    const before = (await api.listProducts()).find((p) => p.id === PERGAMINO)!.stock;

    await user.click(screen.getAllByRole("button", { name: /^Acciones de/ })[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Anular la venta" }));

    // The confirmation says what will happen to the warehouse, not just "are
    // you sure".
    expect(await screen.findByText(/vuelven a Bodega principal con un movimiento de reverso/))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Anular la venta" }));

    await waitFor(async () => {
      const after = (await api.listProducts()).find((p) => p.id === PERGAMINO)!.stock;
      expect(after).toBeGreaterThan(before);
    });
  }, 30000);

  it("keeps the voided sale visible under its own filter", async () => {
    const user = userEvent.setup();
    renderSales();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    await waitFor(() => expect(screen.getAllByText("anulada").length).toBeGreaterThan(0));
  }, 20000);
});
