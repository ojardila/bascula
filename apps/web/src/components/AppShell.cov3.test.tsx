// SPDX-License-Identifier: MIT
/**
 * «Ayuda y recorrido» at the foot of the navigation drawer (the account menu
 * has its own, tested elsewhere): it closes the drawer and starts the tour
 * the person's role has, which the server is told about.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { AppShell } from "./AppShell";
import { AuthProvider } from "../auth/AuthContext";
import { TourProvider } from "../features/onboarding/TourContext";
import { invalidateRefs } from "../api/refs";
import { theme } from "../theme";
import * as db from "../mocks/db";
import { OWNER, signInOwner } from "../test/renderWithAuth";

beforeEach(() => {
  invalidateRefs();
  localStorage.clear();
  signInOwner();
});

describe("AppShell drawer help", () => {
  it("closes the drawer and starts the owner's tour", async () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/cosecha"]}>
          <AuthProvider>
            <TourProvider>
              <Routes>
                <Route path="*" element={<AppShell><p>contenido</p></AppShell>} />
              </Routes>
            </TourProvider>
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Abrir menú" }));
    const drawer = await screen.findByRole("presentation");
    await user.click(within(drawer).getByRole("button", { name: "Ayuda y recorrido" }));

    await waitFor(() => expect(screen.queryByRole("presentation")).not.toBeInTheDocument());
    await waitFor(() => {
      const rows = db.tenantOf(db.FARM_ID)!.tours?.[OWNER] ?? [];
      expect(rows.find((r) => r.tour === "owner")?.status).toBe("active");
    });
  });
});
