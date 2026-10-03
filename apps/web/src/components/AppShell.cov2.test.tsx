// SPDX-License-Identifier: MIT
/**
 * The shell's remaining corners: the support console entry for a platform
 * admin, the read-only chip on a suspended farm, a module that is not ready
 * yet, and the mobile drawer closed with Escape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { AppShell } from "./AppShell";
import { AuthProvider } from "../auth/AuthContext";
import { TourProvider } from "../features/onboarding/TourContext";
import { setTokens } from "../api/client";
import { theme } from "../theme";
import { server } from "../mocks/node";
import * as db from "../mocks/db";

const flags = vi.hoisted(() => ({ withFuture: false }));
vi.mock("../auth/permissions", async (orig) => {
  const real = await orig<typeof import("../auth/permissions")>();
  return {
    ...real,
    visibleModules: (p: Parameters<typeof real.visibleModules>[0]) => {
      const list = real.visibleModules(p);
      if (!flags.withFuture) return list;
      return [
        ...list,
        { ...list[0], key: "future", label: "Bodega nueva", path: "/bodega-nueva", available: false },
      ];
    },
  };
});

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const SUPER = "0192f3a0-0001-7000-8000-000000000009";

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderShell(userId = OWNER) {
  db.resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha"]}>
        <AuthProvider>
          <TourProvider>
            <Routes>
              <Route
                path="*"
                element={
                  <AppShell>
                    <Where />
                  </AppShell>
                }
              />
            </Routes>
          </TourProvider>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  flags.withFuture = false;
  setTokens(null);
  localStorage.removeItem("bascula.lastUser");
});

describe("AppShell", () => {
  it("offers a platform admin the support console", async () => {
    const user = userEvent.setup();
    renderShell(SUPER);
    await user.click(await screen.findByRole("button", { name: "Cuenta" }));
    await user.click(await screen.findByRole("menuitem", { name: "Consola de soporte" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/admin/fincas"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("marks a suspended farm as read-only", async () => {
    localStorage.setItem(
      "bascula.lastUser",
      JSON.stringify({
        id: OWNER,
        email: "oscar@laesperanza.co",
        name: "Oscar",
        role: "owner",
        isSuperAdmin: false,
        farm: { id: db.FARM_ID, name: "La Esperanza", slug: "x", timezone: "America/Bogota", currency: "COP", status: "suspended", trialDaysLeft: null },
        memberships: [],
      }),
    );
    server.use(
      http.get("*/v1/me", () =>
        HttpResponse.json({ error: { code: "UNAVAILABLE", message: "down" } }, { status: 503 }),
      ),
    );
    renderShell();
    expect(await screen.findByText("Suspendida · solo lectura")).toBeInTheDocument();
  });

  it("shows a module that is not ready yet as locked, with «pronto»", async () => {
    flags.withFuture = true;
    renderShell();
    const items = await screen.findAllByText("Bodega nueva");
    const row = items[0].closest("[aria-disabled='true']") as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText("pronto")).toBeInTheDocument();
    expect(row.tagName).toBe("DIV");
  });

  it("closes the mobile drawer with Escape", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole("button", { name: "Abrir menú" }));
    const drawer = await screen.findByRole("presentation");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(drawer).toHaveStyle({ visibility: "hidden" }));
  });
});
