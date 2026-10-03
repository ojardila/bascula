// SPDX-License-Identifier: MIT
/**
 * The shell around every page: the account menu (change password, the tour,
 * signing out) and the mobile drawer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { AppShell } from "./AppShell";
import { AuthProvider } from "../auth/AuthContext";
import { TourProvider } from "../features/onboarding/TourContext";
import { getTokens, setTokens } from "../api/client";
import { invalidateRefs } from "../api/refs";
import { theme } from "../theme";
import * as db from "../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.hash}</div>;
}

function renderShell(userId = OWNER) {
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

async function openAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Cuenta" }));
  return screen.findByRole("menu");
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
});

describe("the account menu", () => {
  it("sends an owner to change the password in Configuración", async () => {
    const user = userEvent.setup();
    renderShell();
    await openAccount(user);
    expect(screen.getByText("oscar@laesperanza.co")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Cambiar clave" }));
    expect(screen.getByTestId("where")).toHaveTextContent(
      "/configuracion#clave",
    );
  });

  it("sends a weigher to change it in Conexiones", async () => {
    const user = userEvent.setup();
    renderShell(WEIGHER);
    await openAccount(user);
    await user.click(screen.getByRole("menuitem", { name: "Cambiar clave" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/conexiones#clave");
  });

  it("starts the tour from «Ayuda y recorrido»", async () => {
    const user = userEvent.setup();
    renderShell();
    await openAccount(user);
    const help = screen.queryByRole("menuitem", { name: "Ayuda y recorrido" });
    expect(help).not.toBeNull();
    await user.click(help!);
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("signs out and goes to the login", async () => {
    const user = userEvent.setup();
    renderShell();
    await openAccount(user);
    await user.click(screen.getByRole("menuitem", { name: "Cerrar sesión" }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/entrar"),
    );
    expect(getTokens()).toBeNull();
  });

  it("closes with Escape", async () => {
    const user = userEvent.setup();
    renderShell();
    await openAccount(user);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });
});

describe("the mobile drawer", () => {
  it("opens from the menu button and closes when a module is picked", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(await screen.findByRole("button", { name: "Abrir menú" }));
    const links = await screen.findAllByRole("link", { name: /Lotes/ });
    await user.click(links[links.length - 1]);
    expect(screen.getByTestId("where")).toHaveTextContent("/lotes");
  });
});
