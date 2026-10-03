// SPDX-License-Identifier: MIT
/**
 * The weighing screen refreshes the kilo price rules kept on the phone in the
 * background. When that refresh fails outright (the server refused and the
 * phone's own copy could not be read either), the screen does not care: the
 * people and the lotes are there and a weighing still goes in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";
import * as priceBook from "../../offline/priceBook";

vi.mock("../../offline/priceBook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../offline/priceBook")>();
  return { ...real, syncPriceBook: vi.fn(() => Promise.reject(new Error("IndexedDB is gone"))) };
});

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  signInOwner();
});
afterEach(() => vi.clearAllMocks());

describe("WeighingForm when the price book cannot be refreshed", () => {
  it("still opens with the people and saves a weighing", async () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/cosecha/recoleccion?quien=uno"]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText(/^Persona/));
    await user.click(await screen.findByRole("option", { name: /Jhon Fredy/ }));
    await waitFor(() => expect(priceBook.syncPriceBook).toHaveBeenCalled());

    const before = db.tenantOf(db.FARM_ID)!.workRecords.length;
    const lote = screen.queryAllByRole("button", { name: /Alto/ })[0];
    if (lote && lote.getAttribute("aria-pressed") !== "true") await user.click(lote);
    await user.type(screen.getByLabelText(/Kilos/), "20");
    await user.click(screen.getByRole("button", { name: "Guardar pesada" }));
    await waitFor(() => expect(db.tenantOf(db.FARM_ID)!.workRecords).toHaveLength(before + 1));
  }, 30_000);
});
