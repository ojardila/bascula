// SPDX-License-Identifier: MIT
/**
 * The guards: the support console refuses a farm owner, and the
 * "no tiene permiso" page leaves by its button or by itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { theme } from "../theme";
import { signInOwner } from "../test/renderWithAuth";
import { PermissionDenied, RequireSuperAdmin } from "./Guards";

function Where() {
  return <output aria-label="ruta">{useLocation().pathname}</output>;
}

function renderAt(path: string, routes: React.ReactNode) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>{routes}</Routes>
          <Where />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  setTokens(null);
});

describe("RequireSuperAdmin", () => {
  it("sends a farm owner to the harvest instead of the console", async () => {
    signInOwner();
    renderAt(
      "/admin/fincas",
      <>
        <Route
          path="/admin/fincas"
          element={
            <RequireSuperAdmin>
              <p>Consola</p>
            </RequireSuperAdmin>
          }
        />
        <Route path="/cosecha" element={<p>Cosecha</p>} />
      </>,
    );
    expect(await screen.findByText("Cosecha")).toBeInTheDocument();
    expect(screen.queryByText("Consola")).not.toBeInTheDocument();
  });
});

describe("PermissionDenied", () => {
  it("leaves the module when the button is pressed", async () => {
    const user = userEvent.setup();
    signInOwner();
    renderAt(
      "/secreto",
      <>
        <Route path="/secreto" element={<PermissionDenied moduleName="ver esto" />} />
        <Route path="/cosecha" element={<p>Cosecha</p>} />
      </>,
    );
    expect(await screen.findByRole("heading", { name: "No tiene permiso para ver esto" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Salir del módulo/ }));
    expect(await screen.findByText("Cosecha")).toBeInTheDocument();
  });

  it("counts down and leaves by itself; on the landing page the count disappears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signInOwner();
    renderAt("/cosecha", <Route path="*" element={<PermissionDenied moduleName="ver esto" />} />);
    await screen.findByRole("button", { name: "Salir del módulo (6)" });
    // Wait for the session so `landing` is the owner's, not the anonymous one.
    await waitFor(() => expect(screen.getByLabelText("ruta")).toHaveTextContent("/cosecha"));
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.getByLabelText("ruta")).toHaveTextContent("/cosecha");
    expect(screen.getByRole("button", { name: "Salir del módulo" })).toBeInTheDocument();
  });
});
