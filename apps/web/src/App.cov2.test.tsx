// SPDX-License-Identifier: MIT
/**
 * `/` on a farm's own address, for somebody already signed in: no front door,
 * straight to the board.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { setTokens } from "./api/client";
import { theme } from "./theme";
import { signInOwner } from "./test/renderWithAuth";

vi.mock("./lib/farmHost", async (orig) => ({
  ...(await orig<typeof import("./lib/farmHost")>()),
  showsFarmEntry: () => true,
}));

function Where() {
  return <output aria-label="ruta">{useLocation().pathname}</output>;
}

afterEach(() => setTokens(null));

describe("HomeRoute on a farm address", () => {
  it("sends a signed-in person from / to the board", async () => {
    signInOwner();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/"]}>
          <AuthProvider>
            <App />
            <Where />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(await screen.findByText("/tablero", {}, { timeout: 5000 })).toBeInTheDocument();
  }, 20000);
});
