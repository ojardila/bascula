import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { theme } from "../../theme";
import { FarmEntryPage } from "./FarmEntryPage";
import { ForgotPasswordPage } from "../auth/ForgotPasswordPage";

function renderAt(hostname: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <FarmEntryPage hostname={hostname} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("the farm's front door", () => {
  it("offers only enter and forgotten password on a farm address", async () => {
    renderAt("cafin3.bascula.engp.io");
    // No farm by that name in the mock: the slug is the fallback.
    expect(await screen.findByText("Finca cafin3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(screen.queryByRole("link", { name: /Registrar/ })).toBeNull();
    expect(screen.queryByText(/Registrar|Crear.*finca/i)).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "¿Olvidó su clave o su usuario?" })).toHaveAttribute("href", "/olvide-mi-clave");
    expect(screen.queryByText(/Solicitar una demostración/)).toBeNull();
  });

  it("greets people with the farm's name, not its web address", async () => {
    renderAt("la-esperanza.bascula.engp.io");
    expect(await screen.findByText("Finca La Esperanza")).toBeInTheDocument();
    expect(screen.queryByText(/la-esperanza/)).toBeNull();
  });

  it("never offers to register on a dev farm either; the demo (a main domain) does", () => {
    const { unmount } = renderAt("cafin3.int.dev.engp.io");
    expect(screen.queryByRole("link", { name: /Registrar/ })).toBeNull();
    unmount();
    renderAt("bascula.int.dev.engp.io");
    expect(screen.getByRole("link", { name: "Registrar" })).toHaveAttribute("href", "/empezar");
  });

  it("says who resets a forgotten password", () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <ForgotPasswordPage />
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(screen.getByText(/Configuración → Usuarios/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a entrar" })).toHaveAttribute("href", "/entrar");
  });
});
