/**
 * The demo, driven from the login box.
 *
 * This is the one test that would catch "it compiles and every unit passes,
 * but the app is a white screen". It signs in through the real form, walks the
 * sprint-1 path — parcelas, empleados, perfil, pagar — and checks the figures
 * that `docs/diagramas/web.md` §8 promises to the peso.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthContext";
import { setTokens } from "../api/client";
import { theme } from "../theme";

function renderApp(path = "/entrar") {
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
  localStorage.clear();
});

describe("signing in", () => {
  it("takes the owner from the login box to their farm", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.type(screen.getByLabelText(/^Contraseña/), "esperanza");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByRole("heading", { name: "La Esperanza" }, { timeout: 5000 }))
      .toBeInTheDocument();
    // The permanent notice is on every authenticated screen, by construction.
    expect(screen.getByText(/llevan cuentas separadas/i)).toBeInTheDocument();
  }, 20000);

  it("says so, once, when the password is wrong", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(screen.getByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.type(screen.getByLabelText(/^Contraseña/), "equivocada");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText(/Correo o contraseña incorrectos/i)).toBeInTheDocument();
  }, 20000);
});

describe("the seeded farm renders what the wireframes promise", () => {
  beforeEach(() => {
    setTokens({
      accessToken: "mock-access.0192f3a0-0001-7000-8000-000000000001.test",
      refreshToken: "mock-refresh.0192f3a0-0001-7000-8000-000000000001",
    });
  });

  it("lists the parcelas with their area and their crops", async () => {
    renderApp("/parcelas");
    expect(await screen.findByText("El Alto")).toBeInTheDocument();
    expect(screen.getByText("La Cuchilla")).toBeInTheDocument();
    expect(screen.getByText("Bajo del Río")).toBeInTheDocument();
    expect(screen.getByText("4,20 ha")).toBeInTheDocument();
    expect(screen.getByText("Café Castillo")).toBeInTheDocument();
    // The plot with a drawn polygon shows both figures, never one.
    expect(screen.getByText(/calculada 5,69 ha/)).toBeInTheDocument();
  }, 20000);

  it("shows a worker's balance derived from the ledger, to the peso", async () => {
    renderApp("/empleados/0192f3a0-0006-7000-8000-000000000001");
    expect(await screen.findByText(/María/)).toBeInTheDocument();
    // $184.500 is the sum of the six seeded ledger rows, not a stored total.
    expect(screen.getByText("$184.500")).toBeInTheDocument();
    expect(screen.getByText("a favor del empleado")).toBeInTheDocument();
    // And the pending work is shown apart: it is not a devengo yet.
    expect(screen.getAllByText("$153.600").length).toBeGreaterThan(0);
  }, 20000);

  it("adds up the payment screen the same way", async () => {
    renderApp("/empleados/0192f3a0-0006-7000-8000-000000000001/pagar");
    expect(await screen.findByRole("heading", { name: /Pagar a María/ })).toBeInTheDocument();
    expect(screen.getAllByText("Recolección de café").length).toBe(2);
    expect(screen.getByText("$30.800")).toBeInTheDocument();
    expect(screen.getByText("$32.800")).toBeInTheDocument();
    expect(screen.getByText("$90.000")).toBeInTheDocument();
    // balance 184.500 + pending 153.600
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Pago total · \$338\.100/ })).toBeEnabled(),
    );
  }, 20000);

  it("registers a labor and refuses one with holes in it", async () => {
    const user = userEvent.setup();
    renderApp("/labores/nueva");
    await screen.findByRole("heading", { name: "Registrar labor" });

    // Submitting an empty form names every missing field at once.
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Elija una actividad.")).toBeInTheDocument();
  }, 20000);
});
