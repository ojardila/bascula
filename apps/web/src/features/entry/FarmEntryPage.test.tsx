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
  it("offers enter, register and forgotten password on a farm address", () => {
    renderAt("cafin3.bascula.engp.io");
    expect(screen.getByText("Finca cafin3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(screen.getByRole("link", { name: "Registrar" })).toHaveAttribute("href", "https://bascula.engp.io/empezar");
    expect(screen.getByRole("link", { name: "¿Olvidó su clave o su usuario?" })).toHaveAttribute("href", "/olvide-mi-clave");
    expect(screen.queryByText(/Solicitar una demostración/)).toBeNull();
  });

  it("registers on the dev main domain from a dev farm, and in place on the demo", () => {
    renderAt("cafin3.int.dev.engp.io");
    expect(screen.getByRole("link", { name: "Registrar" })).toHaveAttribute("href", "https://bascula.int.dev.engp.io/empezar");
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
