// SPDX-License-Identifier: MIT
/**
 * The export card's rule: it is for whoever can read money OR read every
 * record. No role of today has the second without the first, so the matrix
 * is narrowed here to a principal that only reads records, and the card must
 * still be offered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { ConfigPage } from "./ConfigPage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { signInOwner } from "../../test/renderWithAuth";

vi.setConfig({ testTimeout: 30_000 });

vi.mock("../../auth/permissions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../auth/permissions")>();
  return {
    ...real,
    can: (p: Parameters<typeof real.can>[0], action: Parameters<typeof real.can>[1]) =>
      action === "money.read" ? false : real.can(p, action),
  };
});

beforeEach(() => {
  invalidateRefs();
});

describe("ConfigPage without money.read", () => {
  it("offers the export to someone who reads every record", async () => {
    signInOwner();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/configuracion"]}>
          <AuthProvider>
            <ConfigPage />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Descargar datos" })).toBeInTheDocument();
  });
});
