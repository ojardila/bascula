// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { resetDb } from "../../mocks/db";
import type { Product } from "../../api/types";
import { SaleFormDialog } from "./SaleFormDialog";

const PRODUCT = {
  id: "p1",
  name: "Café seco",
  categoryId: null,
  categoryName: null,
  storageUnitId: "u1",
  storageUnit: "Bulto",
  note: null,
  stock: 0,
  status: "active",
} as Product;

describe("SaleFormDialog, signed out, one warehouse, nothing on record", () => {
  it("preselects the only warehouse and reads a missing stock line as zero", async () => {
    resetDb();
    setTokens(null);
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AuthProvider>
            <SaleFormDialog
              open
              products={[PRODUCT]}
              customers={[]}
              warehouses={[{ id: "w1", name: "Bodega única" }]}
              levels={[]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
            />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Bodega única")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: /^Producto/ }));
    await user.click(await screen.findByRole("option", { name: /Café seco/ }));
    expect(within(dialog).getByText("En bodega hay 0 Bulto.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: /^Cantidad/ }), "5");
    expect(within(dialog).getByText(/La bodega dice que solo hay/)).toHaveTextContent("0 Bulto");
  });
});
