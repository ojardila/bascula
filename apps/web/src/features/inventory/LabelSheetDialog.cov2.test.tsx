// SPDX-License-Identifier: MIT
/** The sticker sheet's «Imprimir» hands the page to the browser's print. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material";
import { LabelSheetDialog } from "./LabelSheetDialog";
import { theme } from "../../theme";
import type { LabelBatch } from "../../api/types";

afterEach(() => vi.restoreAllMocks());

const batch: LabelBatch = {
  id: "b1",
  stockMoveId: "m1",
  count: 1,
  labels: [
    {
      code: "CAF-0001",
      productName: "Café pergamino seco",
      storageUnit: "Bulto",
      qty: 2,
      warehouseName: "Bodega principal",
      plotName: null,
      date: "2026-09-25",
    },
  ],
};

describe("LabelSheetDialog", () => {
  it("prints the sheet", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <LabelSheetDialog batch={batch} onClose={vi.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByText("Stickers de esa entrada (1)")).toBeInTheDocument();
    expect(screen.getByText("CAF-0001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Imprimir" }));
    expect(print).toHaveBeenCalledTimes(1);
  });
});
