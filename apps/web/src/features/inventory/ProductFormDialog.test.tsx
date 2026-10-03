// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { ProductFormDialog } from "./ProductFormDialog";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import type { CatalogItem, Product } from "../../api/types";

const categories: CatalogItem[] = [
  { id: "0192f3a0-000e-7000-8000-000000000001", name: "Materia prima" },
  { id: "0192f3a0-000e-7000-8000-000000000002", name: "Producto procesado" },
] as CatalogItem[];
const units: CatalogItem[] = [
  { id: "0192f3a0-000f-7000-8000-000000000001", name: "Bulto" },
  { id: "0192f3a0-000f-7000-8000-000000000002", name: "Kilo" },
] as CatalogItem[];

const existing: Product = {
  id: "0192f3a0-0011-7000-8000-000000000001",
  name: "Café pergamino seco",
  categoryId: categories[1].id,
  categoryName: "Producto procesado",
  storageUnitId: units[0].id,
  storageUnit: "Bulto",
  note: null,
  stock: 28,
  status: "active",
} as Product;

function open(product: Product | null) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  renderWithAuth(
    <ProductFormDialog
      open
      product={product}
      categories={categories}
      storageUnits={units}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

beforeEach(() => signInOwner());

describe("ProductFormDialog", () => {
  it("asks for a name and a storage unit before saving", async () => {
    const user = userEvent.setup();
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Nuevo producto")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/No se pide cantidad inicial/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar producto" }),
    );
    expect(
      await within(dialog).findByText("Escriba el nombre del producto."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Elija en qué unidad se guarda/),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("creates a product with a typed category and a picked unit", async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && request.url.endsWith("/v1/products")) {
        body = (await request.clone().json()) as Record<string, unknown>;
      }
    });
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(/^Nombre/),
      "  Abono orgánico ",
    );
    await user.type(
      within(dialog).getByRole("combobox", { name: "Categoría" }),
      "Insumos",
    );
    await user.click(
      await screen.findByRole("option", {
        name: /Agregar la categoría «Insumos»/,
      }),
    );
    await user.click(
      within(dialog).getByRole("combobox", {
        name: /Unidad de almacenamiento/,
      }),
    );
    await user.click(await screen.findByRole("option", { name: "Kilo" }));
    await user.type(within(dialog).getByLabelText(/Nota/), "Para la siembra");
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar producto" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][0]).toMatchObject({
      name: "Abono orgánico",
      storageUnit: "Kilo",
    });
    expect(body).toMatchObject({
      name: "Abono orgánico",
      note: "Para la siembra",
    });
    server.events.removeAllListeners();
  });

  it("creates a product with a typed new unit", async () => {
    const user = userEvent.setup();
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombre/), "Fertilizante");
    await user.type(
      within(dialog).getByRole("combobox", {
        name: /Unidad de almacenamiento/,
      }),
      "Galón",
    );
    await user.click(
      await screen.findByRole("option", { name: /Agregar la unidad «Galón»/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar producto" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][0]).toMatchObject({
      name: "Fertilizante",
      storageUnit: "Galón",
    });
  });

  it("edits an existing product", async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = open(existing);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Modificar producto")).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/No se pide cantidad inicial/),
    ).not.toBeInTheDocument();
    const name = within(dialog).getByLabelText(/^Nombre/);
    await user.clear(name);
    await user.type(name, "Café pergamino");
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar producto" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0][0]).toMatchObject({ name: "Café pergamino" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's refusal and stays open", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/products", () =>
        HttpResponse.json(
          { error: { code: "DUPLICATE_NAME", message: "dup", details: {} } },
          { status: 409 },
        ),
      ),
    );
    const { onSaved } = open(null);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Nombre/), "Café cereza");
    await user.click(
      within(dialog).getByRole("combobox", {
        name: /Unidad de almacenamiento/,
      }),
    );
    await user.click(await screen.findByRole("option", { name: "Bulto" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Guardar producto" }),
    );
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
