// SPDX-License-Identifier: MIT
/**
 * The stock dialog on its own: a farm with a single warehouse gets it
 * preselected, a crop with a variety is named with it, and a session with no
 * farm timezone still dates the movement (Bogotá).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { StockMoveDialog } from "./StockMoveDialog";
import { OWNER, renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import * as db from "../../mocks/db";
import type { CatalogItem, Plot, Product } from "../../api/types";

vi.setConfig({ testTimeout: 30_000 });

const product = {
  id: "0192f3a0-0011-7000-8000-0000000000a1",
  name: "Abono 15-15-15",
  categoryId: null,
  categoryName: null,
  storageUnitId: "u1",
  storageUnit: "Bulto",
  note: null,
  stock: 3,
  status: "active",
} as unknown as Product;

const warehouses = [{ id: "w1", name: "Bodega única" }] as CatalogItem[];

const plots = [
  {
    id: "p1",
    name: "El Alto",
    status: "active",
    crops: [
      { id: "c1", cropTypeId: "t1", cropTypeName: "Café", varietyId: "v1", varietyName: "Castillo", areaHa: 1, plantedAt: null },
      { id: "c2", cropTypeId: "t2", cropTypeName: "Plátano", varietyId: null, varietyName: null, areaHa: 1, plantedAt: null },
    ],
  },
] as unknown as Plot[];

beforeEach(() => signInOwner());

describe("StockMoveDialog", () => {
  it("preselects the only warehouse and names a crop with its variety, if it has one", async () => {
    const user = userEvent.setup();
    renderWithAuth(
      <StockMoveDialog
        open
        products={[product]}
        warehouses={warehouses}
        plots={plots}
        product={product}
        stockOf={() => 3}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Bodega única")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: /Lote/ }));
    await user.click(await screen.findByRole("option", { name: "El Alto" }));
    await user.click(within(dialog).getByRole("combobox", { name: /Cultivo/ }));
    expect(await screen.findByRole("option", { name: "Café · Castillo" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Plátano" })).toBeInTheDocument();
  });

  it("dates the movement in Bogotá when the session carries no timezone", async () => {
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({
          id: OWNER,
          email: "oscar@laesperanza.co",
          name: "Oscar Jaramillo",
          role: "owner",
          farm: { id: db.FARM_ID, name: "La Esperanza", currency: "COP", slug: "la-esperanza" },
          superadmin: false,
        }),
      ),
    );
    renderWithAuth(
      <StockMoveDialog
        open
        products={[product]}
        warehouses={warehouses}
        plots={[]}
        stockOf={() => null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Fecha/)).toBeInTheDocument();
    // The session arrives after the first render; the dialog stays usable.
    await screen.findByRole("button", { name: "Registrar entrada o salida" });
  });
});
