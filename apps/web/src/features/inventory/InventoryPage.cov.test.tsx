/**
 * Inventory, the remaining edges: a long movement list that is cut off and
 * says so, a warehouse below zero, the sticker sheet of an entry, the forms
 * opened while their pickers failed to load, the movement preview without
 * levels, and a session that may read the warehouse but not write to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { InventoryPage } from "./InventoryPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { resetDb, tenantOf, FARM_ID } from "../../mocks/db";

/** Switched on by the one test that needs a session without `stock.write`. */
const perms = vi.hoisted(() => ({ denyStockWrite: false }));
vi.mock("../../auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/permissions")>();
  return {
    ...actual,
    can: (...args: Parameters<typeof actual.can>) =>
      perms.denyStockWrite && args[1] === "stock.write" ? false : actual.can(...args),
  };
});

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const PRODUCT = "Café pergamino seco";

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

const boom = () =>
  HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 });

const errorAlert = () => document.querySelector<HTMLElement>(".MuiAlert-colorError");

beforeEach(() => {
  perms.denyStockWrite = false;
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function openTab(user: User, name: string) {
  await screen.findByText(PRODUCT);
  await user.click(screen.getByRole("tab", { name }));
}

describe("what the lists say about themselves", () => {
  it("says when the movements were cut off, and shows a warehouse below zero in red", async () => {
    const t = tenantOf(FARM_ID)!;
    const first = t.stockMoves[0];
    // Far below zero for one product in one warehouse…
    t.stockMoves.push({ ...first, id: "0192f3a0-0012-7000-8000-0000000fffff", qty: -99999 });
    // …and more movements than one page holds.
    for (let i = 0; i < 200; i++) {
      t.stockMoves.push({
        ...first,
        id: `0192f3a0-0012-7000-8000-${String(100000000000 + i)}`,
        qty: 1,
      });
    }
    const user = userEvent.setup();
    renderInventory();
    await openTab(user, "Existencias por bodega");
    expect(
      await screen.findByText(/Se muestran las 200 más recientes/),
    ).toBeInTheDocument();
    const negative = await screen.findByText(/^-/, { selector: "span" });
    expect(negative).toHaveClass("MuiTypography-root");

    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));
    expect(
      await screen.findByText(/Se muestran las 200 más recientes/),
    ).toBeInTheDocument();
  }, 30000);

  it("puts a dash where a product has no category", async () => {
    const t = tenantOf(FARM_ID)!;
    t.products.forEach((p) => {
      p.categoryId = null;
    });
    renderInventory();
    const row = (await screen.findByText(PRODUCT)).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
  }, 20000);
});

describe("the stickers of an entry", () => {
  it("opens the existing sheet and closes it", async () => {
    const user = userEvent.setup();
    renderInventory();
    await openTab(user, "Entradas y salidas");
    const [stickers] = await screen.findAllByRole("button", {
      name: /^Stickers de la entrada de/,
    });
    await user.click(stickers);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  }, 30000);

  it("says why the sheet could not be opened", async () => {
    server.use(http.get("*/v1/label-batches/:id", boom));
    const user = userEvent.setup();
    renderInventory();
    await openTab(user, "Entradas y salidas");
    const [stickers] = await screen.findAllByRole("button", {
      name: /^Stickers de la entrada de/,
    });
    await user.click(stickers);
    await waitFor(() => expect(errorAlert()).not.toBeNull());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  }, 30000);
});

describe("the product form", () => {
  it("opens from the row menu and saves", async () => {
    const user = userEvent.setup();
    renderInventory();
    await user.click(await screen.findByRole("button", { name: `Acciones de ${PRODUCT}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/^Nombre/);
    await user.clear(name);
    await user.type(name, "Café pergamino especial");
    await user.click(within(dialog).getByRole("button", { name: "Guardar producto" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Café pergamino especial")).toBeInTheDocument();
  }, 30000);

  it("still opens when the categories and units could not be loaded", async () => {
    server.use(
      http.get("*/v1/catalogs/product-categories", boom),
      http.get("*/v1/catalogs/storage-units", boom),
    );
    const user = userEvent.setup();
    renderInventory();
    await user.click(await screen.findByRole("button", { name: "Nuevo producto" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Unidad de almacenamiento/ }));
    expect(screen.queryByRole("option", { name: "Bulto" })).not.toBeInTheDocument();
  }, 30000);
});

describe("the movement dialog", () => {
  it("still opens when products, warehouses and lotes could not be loaded", async () => {
    server.use(
      http.get("*/v1/stock/moves", () => HttpResponse.json({ items: [] })),
      http.get("*/v1/products", boom),
      http.get("*/v1/warehouses", boom),
      http.get("*/v1/plots", boom),
    );
    const user = userEvent.setup();
    renderInventory();
    await waitFor(() => expect(errorAlert()).not.toBeNull());
    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));
    await user.click(await screen.findByRole("button", { name: "Registrar el primero" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    expect(screen.queryByRole("option", { name: new RegExp(PRODUCT) })).not.toBeInTheDocument();
  }, 30000);

  it("opens the sticker sheet that came back with an entry", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText(PRODUCT);
    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: new RegExp(PRODUCT) }));
    await user.click(within(dialog).getByRole("combobox", { name: /Bodega/ }));
    await user.click(await screen.findByRole("option", { name: "Bodega principal" }));
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "3");
    await user.click(
      within(dialog).getByLabelText(/Imprimir stickers de identificación/),
    );
    await user.click(within(dialog).getByRole("button", { name: "Registrar entrada o salida" }));
    // The movement dialog gives way to the sheet of its stickers.
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("button", { name: "Cerrar" })).toBeInTheDocument();
  }, 30000);

  it("shows no preview when the levels could not be read", async () => {
    server.use(http.get("*/v1/stock", boom));
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText(PRODUCT);
    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: new RegExp(PRODUCT) }));
    await user.click(within(dialog).getByRole("combobox", { name: /Bodega/ }));
    await user.click(await screen.findByRole("option", { name: "Bodega principal" }));
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "10");
    expect(within(dialog).queryByText(/Después de esto quedan/)).not.toBeInTheDocument();
  }, 30000);

  it("counts a warehouse that never held the product as empty", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText(PRODUCT);
    await user.click(screen.getByRole("button", { name: "Registrar entrada o salida" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /Producto/ }));
    await user.click(await screen.findByRole("option", { name: /Fungicida/ }));
    await user.click(within(dialog).getByRole("combobox", { name: /Bodega/ }));
    await user.click(await screen.findByRole("option", { name: "Beneficiadero" }));
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "10");
    expect(await within(dialog).findByText(/Después de esto quedan/)).toBeInTheDocument();
  }, 30000);
});

describe("a session that may not write to the warehouse", () => {
  it("offers no way to record the first movement", async () => {
    perms.denyStockWrite = true;
    server.use(http.get("*/v1/stock/moves", () => HttpResponse.json({ items: [] })));
    const user = userEvent.setup();
    renderInventory();
    await openTab(user, "Entradas y salidas");
    expect(
      await screen.findByText(/Todavía no ha entrado ni salido nada/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Registrar el primero" }),
    ).not.toBeInTheDocument();
  }, 30000);
});
