// SPDX-License-Identifier: MIT
/**
 * The person picker of a special price, for somebody registered without a
 * surname: the name alone, with no trailing space.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SpecialPricesCard } from "./SpecialPricesCard";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { signInOwner } from "../../test/renderWithAuth";

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signInOwner();
});
afterEach(() => vi.restoreAllMocks());

describe("SpecialPricesCard person picker", () => {
  it("lists a person with no surname by the name alone", async () => {
    const real = api.listWorkers.bind(api);
    vi.spyOn(api, "listWorkers").mockImplementation(async (...args) => {
      const [first, ...rest] = await real(...args);
      return [{ ...first, name: "Rosalba", lastName: undefined as unknown as string }, ...rest];
    });
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <AuthProvider>
            <SpecialPricesCard canEdit />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await user.click(
      await screen.findByRole("button", { name: "Precio especial para una persona" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("¿Qué persona?"));
    const option = await screen.findByRole("option", { name: "Rosalba" });
    expect(option.textContent).toBe("Rosalba");
  });
});
