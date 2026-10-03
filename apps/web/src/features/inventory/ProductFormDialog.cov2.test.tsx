// SPDX-License-Identifier: MIT
/** A product whose category came back without a name still opens for editing. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { ProductFormDialog } from "./ProductFormDialog";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import type { CatalogItem, Product } from "../../api/types";

beforeEach(() => signInOwner());

describe("ProductFormDialog", () => {
  it("opens a product whose category has no name with the category box empty", async () => {
    const product = {
      id: "0192f3a0-0011-7000-8000-000000000009",
      name: "Cal agrícola",
      categoryId: "0192f3a0-000e-7000-8000-000000000009",
      categoryName: null,
      storageUnitId: "0192f3a0-000f-7000-8000-000000000001",
      storageUnit: "Bulto",
      note: null,
      stock: 0,
      status: "active",
    } as unknown as Product;
    renderWithAuth(
      <ProductFormDialog
        open
        product={product}
        categories={[] as CatalogItem[]}
        storageUnits={[{ id: product.storageUnitId, name: "Bulto" }] as CatalogItem[]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Cal agrícola")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: /Categoría/ })).toHaveValue("");
  });
});
