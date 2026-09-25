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
        name: /Sepa qué deja cada lote de café/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/De la romana al recibo — fincas cafeteras/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pedir demo" }).length).toBeGreaterThanOrEqual(1);
    // MUI required fields append an asterisk to the label textContent, so exact
    // getByLabelText("Nombre") fails even though the control is correctly labeled.
    expect(screen.getAllByRole("textbox", { name: /^Nombre$/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("textbox", { name: /^Teléfono$/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("textbox", { name: /^Correo$/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("textbox", { name: /^Nombre de la finca$/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("leads with a free self-serve signup next to the demo", async () => {
    renderApp("/");
    const ctas = await screen.findAllByRole("link", { name: "Cree su finca gratis" });
    expect(ctas.length).toBeGreaterThanOrEqual(1);
    expect(ctas[0]).toHaveAttribute("href", "/empezar");
  });

  it("lets someone start a farm and pick its web address", async () => {
    renderApp("/empezar");
    expect(await screen.findByRole("heading", { name: "Cree su finca" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Dirección web de la finca/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Precio por kilo/)).toBeNull();
  });
});
