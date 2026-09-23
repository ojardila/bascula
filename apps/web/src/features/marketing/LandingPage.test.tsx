import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";

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

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

describe("the public landing", () => {
  it("frames coffee-farm administration and asks for a demo", async () => {
    renderApp("/");
    expect(
      await screen.findByRole("heading", {
        name: /La cosecha, los kilos y la liquidación, en orden/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Administración de fincas cafeteras/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pedir demo" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText("Nombre").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText("Teléfono").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText("Correo").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText("Nombre de la finca").length).toBeGreaterThanOrEqual(1);
  });

  it("still lets someone start a farm and pick the URL slug", async () => {
    renderApp("/empezar");
    expect(await screen.findByRole("heading", { name: "Crear mi finca" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Identificador/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Teléfono/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Precio por kilo/)).toBeNull();
  });
});
