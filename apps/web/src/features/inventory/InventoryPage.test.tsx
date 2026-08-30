/**
 * The inventory module, with the one rule that shapes it under test.
 *
 * The rule is "las existencias se derivan de lo que entra y sale", and a test that
 * only checked the happy path would not notice the day somebody adds a helpful
 * little "editar cantidad" to the product form. So the first case here asserts
 * an ABSENCE — no field on any screen of this module accepts a quantity in
 * stock — and the rest assert that the way round it works and says why.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { InventoryPage } from "./InventoryPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { resetDb, FARM_ID } from "../../mocks/db";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderInventory() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/inventario"]}>
        <AuthProvider>
          <InventoryPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/**
 * The warehouse has no default when the farm has more than one, so every test
 * that records a movement has to say which shed. That is the point: the seed
 * has two, and preselecting one of them put coffee in the wrong one.
 */
async function pickWarehouse(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name = "Bodega principal",
) {
  await user.click(within(dialog).getByRole("combobox", { name: /Bodega/ }));
  await user.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("stock on hand is derived, and the interface never offers to set it", () => {
  it("shows the stock next to each product and says where the number comes from", async () => {
    renderInventory();
    expect(await screen.findByText("Café pergamino seco")).toBeInTheDocument();
    // 40 in, 12 sold, 5 consumed, 5 back from the voided sale.
    expect(screen.getByText("28 bultos")).toBeInTheDocument();
    expect(screen.getAllByText("de las entradas y salidas").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Las existencias no son un dato que se escriba/),
    ).toBeInTheDocument();
  }, 20000);

  it("offers no way to type a quantity into the product form", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("button", { name: "Nuevo producto" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Nombre/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Unidad de almacenamiento/)).toBeInTheDocument();
    // The absence IS the design: no "cantidad", no "existencias", no "stock".
    expect(within(dialog).queryByLabelText(/cantidad/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/existencias/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/stock/i)).not.toBeInTheDocument();
    // And it says what to do instead.
    expect(within(dialog).getByText(/No se pide cantidad inicial a propósito/))
      .toBeInTheDocument();
  }, 20000);

  it("changes the stock only through a movement, and shows the result first", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");

    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: /Café pergamino seco/ }));
    await pickWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "10");

    // The number they would have typed into a stock column, arrived at the
    // other way round: 28 today, 38 after a harvest of 10.
    expect(await within(dialog).findByText(/Después de esto quedan/))
      .toBeInTheDocument();
    expect(within(dialog).getByText("38 bultos")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Registrar entrada o salida" }));

    await waitFor(() => expect(screen.getByText("38 bultos")).toBeInTheDocument());
  }, 30000);

  it("puts the sign on the movement from the reason, not from the person", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");

    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("combobox", { name: /Motivo/ }));
    await user.click(await screen.findByRole("option", { name: "Merma" }));
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: /Café pergamino seco/ }));
    await pickWarehouse(user, dialog);
    // A POSITIVE number typed, for a reason that takes product out.
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "3");

    expect(within(dialog).getByText("25 bultos")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Registrar entrada o salida" }));
    await waitFor(() => expect(screen.getByText("25 bultos")).toBeInTheDocument());
  }, 30000);

  it("asks before letting a movement take the warehouse below zero, and takes the answer", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");

    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Motivo/ }));
    await user.click(await screen.findByRole("option", { name: "Consumo" }));
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: /Café pergamino seco/ }));
    await pickWarehouse(user, dialog);
    // 28 in the warehouse; this takes out 40.
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "40");

    expect(await within(dialog).findByText(/Queda en negativo/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Registrar entrada o salida" }));
    expect(await within(dialog).findByText(/En esa bodega no hay tanto/)).toBeInTheDocument();

    // The guard exists because a keyboard makes typos; the override exists
    // because a warehouse whose opening balance was never entered is ordinary.
    await user.click(
      within(dialog).getByRole("checkbox", { name: /Regístrelo de todos modos/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Registrar entrada o salida" }));
    await waitFor(() => expect(screen.getByText("-12 bultos")).toBeInTheDocument());
  }, 30000);

  it("will not take an adjustment without an explanation", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");

    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Motivo/ }));
    await user.click(await screen.findByRole("option", { name: "Ajuste" }));
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: /Café pergamino seco/ }));
    await pickWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "2");
    await user.click(within(dialog).getByRole("button", { name: "Registrar entrada o salida" }));

    // An adjustment is the one place a spreadsheet habit lands, so it is the
    // one that has to carry a reason.
    expect(
      await within(dialog).findByText(/número que nadie podrá justificar/),
    ).toBeInTheDocument();
  }, 30000);
});

describe("movements are facts, so they are reversed and never edited", () => {
  it("has no edit anywhere on the movement list, and offers the correction", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));

    expect(await screen.findByText(/Lo que entró o salió no se modifica ni se borra/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Editar/ })).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Corregir la entrada o salida/ }).length,
    ).toBeGreaterThan(0);
  }, 20000);

  it("undoes a movement by recording its opposite, and the stock follows", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));

    const buttons = await screen.findAllByRole("button", { name: /^Corregir la entrada o salida/ });
    await user.click(buttons[0]);

    // A reversal is a new row marked as such, not a deletion of the old one.
    await waitFor(() => expect(screen.getAllByText("corrección").length).toBeGreaterThan(0));
    expect(screen.getAllByText("corregido").length).toBeGreaterThan(0);
  }, 30000);
});

describe("the levels tab", () => {
  it("shows one line per product per warehouse, summed", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("tab", { name: "Existencias por bodega" }));

    expect(await screen.findByText(/Cada línea es una suma de entradas y salidas/))
      .toBeInTheDocument();
    expect(screen.getAllByText("Bodega principal").length).toBeGreaterThan(0);
  }, 20000);
});

/**
 * ── AN EMPTY TABLE IS NOT AN EMPTY WAREHOUSE ─────────────────────────────
 *
 * These two tabs read `{(levels ?? []).map(...)}` and never caught the error,
 * so a failed query left the headers standing and nothing underneath them,
 * without a word. Whoever looks at that draws the only conclusion an empty
 * table supports: there is nothing there. See `components/TableState`.
 */
describe("when the query fails", () => {
  const down = (path: string) =>
    http.get(path, () =>
      HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
    );

  it("the stock tab says so, instead of going blank", async () => {
    const user = userEvent.setup();
    server.use(down("*/v1/stock"));
    renderInventory();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("tab", { name: "Existencias por bodega" }));

    expect(
      await screen.findByText("No se pudieron consultar las existencias."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/vacía porque falló la consulta, no porque no haya nada/),
    ).toBeInTheDocument();
    // And NOT the sentence that claims something about the warehouse.
    expect(
      screen.queryByText("Ninguna bodega tiene existencias todavía."),
    ).not.toBeInTheDocument();
  }, 20000);

  it("and so does the ins-and-outs tab", async () => {
    const user = userEvent.setup();
    server.use(down("*/v1/stock/moves"));
    renderInventory();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));

    expect(
      await screen.findByText("No se pudieron consultar las entradas y salidas."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Todavía no ha entrado ni salido nada."),
    ).not.toBeInTheDocument();
  }, 20000);
});
