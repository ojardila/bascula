import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { users, resetDb } from "../../mocks/db";

const SUPER = "0192f3a0-0001-7000-8000-000000000009";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function signIn() {
  const user = users.find((u) => u.id === SUPER);
  if (!user) throw new Error("no superadmin");
  setTokens({ accessToken: `mock-access.${SUPER}.test`, refreshToken: `mock-refresh.${SUPER}` });
}

beforeEach(() => {
  resetDb();
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

describe("the support console", () => {
  it("lists farms and lets the operator create one", async () => {
    signIn();
    const user = userEvent.setup();
    renderApp("/admin/fincas");
    expect(await screen.findByRole("heading", { name: "Fincas" })).toBeInTheDocument();
    expect(await screen.findByText("La Esperanza")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Nueva finca" }));
    await user.type(screen.getByLabelText(/Nombre de la finca/), "El Roble");
    await user.type(screen.getByLabelText(/Precio por kilo/), "900");
    await user.type(screen.getByLabelText(/Correo del dueño/), "ana.roble@example.com");
    await user.type(screen.getByLabelText(/Nombre del dueño/), "Ana Roble");
    await user.click(screen.getByRole("button", { name: "Crear finca" }));

    expect(await screen.findByText("Finca creada")).toBeInTheDocument();
    expect(screen.getByText(/ana.roble@example.com/)).toBeInTheDocument();
    expect(screen.getAllByText("El Roble").length).toBeGreaterThan(0);
  }, 20000);
});
