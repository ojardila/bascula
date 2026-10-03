/**
 * Render a component the way the app does — theme, router and a signed-in
 * owner of the seeded farm — for the tests that drive a single dialog or card
 * rather than a whole page.
 */
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { theme } from "../theme";
import { FARM_ID, resetDb } from "../mocks/db";

export const OWNER = "0192f3a0-0001-7000-8000-000000000001";

export function signInOwner(userId = OWNER) {
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

export function renderWithAuth(
  ui: ReactElement,
  { path = "/" }: { path?: string } = {},
) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="*" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}
