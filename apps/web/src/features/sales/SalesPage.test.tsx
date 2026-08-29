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
import { server } from "../../mocks/node";
import { http, HttpResponse } from "msw";

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

/**
 * ── «UNIDADES» NO ES UNA UNIDAD ────────────────────────────────────────
 *
 * A sale's quantity is in its PRODUCT'S storage unit. The footer added every
 * sale's quantity together and called the result "N unidades", so twelve
 * bultos of parchment and four hundred kilos of cherry came out as "412
 * unidades" — a number with no unit, printed under a heading that gave it one.
 * Pesos add up across products; bultos and kilos do not.
 */
/**
 * ── UNA CONSULTA CAÍDA NO ES UNA BODEGA VACÍA ──────────────────────────
 *
 * `SaleFormDialog` took `levels: StockLevel[]` and the page handed it
 * `levels ?? []`. With `/v1/stock/levels` down, that empty array said every
 * warehouse on the farm holds nothing — so every sale came up "la bodega dice
 * que solo hay 0" and the only way through the form was to tick "regístrela de
 * todos modos", which sends `allowNegativeStock: true` and switches OFF the
 * server's own stock guard.
 *
 * That is the part that makes it worth a test: the false zero does not merely
 * misinform, it talks somebody into disabling a check.
 */
describe("cuando no se pueden consultar las existencias", () => {
  it("no inventa una bodega vacía ni empuja a saltarse la comprobación", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/stock", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    renderSales();
    await screen.findByRole("heading", { name: "Ventas" });
    await user.click(screen.getByRole("button", { name: "Registrar venta" }));
    const dialog = await screen.findByRole("dialog");
    // 999 of anything is more than the farm has. With the levels loaded this
    // is the case that DOES warn — see the test above — so if a warning shows
    // up here it can only have come from the invented empty warehouse.
    await fillSale(user, dialog, { qty: "999", amount: "100000" });

    // No invented shortage, and no checkbox inviting the guard to be turned off.
    expect(within(dialog).queryByText(/La bodega dice que solo hay/)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText(/Regístrela de todos modos/),
    ).not.toBeInTheDocument();
    // What it says instead is what is true.
    expect(
      within(dialog).getByText(/No se pudieron consultar las existencias/),
    ).toBeInTheDocument();
  }, 20000);
});

describe("el total de cantidades", () => {
  it("solo aparece cuando todas las ventas están en la misma unidad", async () => {
    renderSales();
    // The seeded farm sells one product, so there is one unit and the total is
    // meaningful — and it is named rather than called "unidades".
    const footer = await screen.findByText(/venta\(s\) sin anular/);
    expect(footer).not.toHaveTextContent("unidades");
  }, 20000);

  it("y desaparece en cuanto se mezclan", async () => {
    server.use(
      http.get("*/v1/sales", () =>
        HttpResponse.json({
          totalCents: 200_000_00,
          totalQty: 412,
          items: [
            {
              id: "0192f3a0-0011-7000-8000-0000000000a1",
              productId: "p1", product: "Pergamino", storageUnit: "bulto",
              customerId: null, customer: null,
              warehouseId: "w1", warehouse: "Bodega",
              qty: 12, amountCents: 100_000_00, note: null,
              date: "2026-08-20T00:00:00Z", stockMoveId: null, voidedAt: null,
            },
            {
              id: "0192f3a0-0011-7000-8000-0000000000a2",
              productId: "p2", product: "Cereza", storageUnit: "kg",
              customerId: null, customer: null,
              warehouseId: "w1", warehouse: "Bodega",
              qty: 400, amountCents: 100_000_00, note: null,
              date: "2026-08-21T00:00:00Z", stockMoveId: null, voidedAt: null,
            },
          ],
        }),
      ),
    );
    renderSales();
    const footer = await screen.findByText(/venta\(s\) sin anular/);
    // No total at all rather than a wrong one. The pesos still add up.
    expect(footer).not.toHaveTextContent("412");
    expect(footer).not.toHaveTextContent("unidades");
    expect(footer).toHaveTextContent("$200.000");
  }, 20000);
});

/**
 * ── UN PIE QUE CONTRADICE A LA ALERTA QUE TIENE ENCIMA ──────────────────
 *
 * With the server unreachable this card showed "No se pudo contactar el
 * servidor" and, immediately below it, "0 venta(s) sin anular, por un total de
 * $0". Two statements in one card, one of which is a figure a farm can
 * genuinely have — so the reader has to guess which half to believe.
 *
 * `rows ?? []` and `sales?.totalCents ?? 0` are where both zeros came from.
 * They are fine for arithmetic and fatal for a sentence.
 */
describe("cuando el servidor no responde", () => {
  it("no pone un total de $0 debajo del error", async () => {
    server.use(
      http.get("*/v1/sales", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    renderSales();

    // The refusal is shown…
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // …and nothing claims to know how many sales there were, or for how much.
    expect(screen.queryByText(/venta\(s\) sin anular/)).not.toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  }, 20000);

  /** …and the footer is still there when the list actually loaded. */
  it("pero sí lo pone cuando la lista cargó", async () => {
    renderSales();
    expect(await screen.findByText(/venta\(s\) sin anular/)).toBeInTheDocument();
  }, 20000);
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
