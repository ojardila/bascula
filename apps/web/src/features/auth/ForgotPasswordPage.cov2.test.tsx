// SPDX-License-Identifier: MIT
/**
 * «¿Olvidó su clave?»: an address without an @, the server failing the
 * request, and a server that cannot even say whether reset is available.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { resetDb } from "../../mocks/db";
import { server } from "../../mocks/node";
import { theme } from "../../theme";

function renderForgot() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/olvide-mi-clave"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  resetDb();
  setTokens(null);
  localStorage.clear();
});

describe("ForgotPasswordPage", () => {
  it("asks for a real address before sending anything", async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.type(await screen.findByLabelText(/^Correo/), "oscar");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Escriba el correo con el que entra a la finca.");
  });

  it("shows the server's failure and stays on the form", async () => {
    server.use(
      http.post("*/v1/auth/password-reset/request", () =>
        HttpResponse.json(
          { error: { code: "RATE_LIMITED", message: "slow down", details: {} } },
          { status: 429 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderForgot();
    await user.type(await screen.findByLabelText(/^Correo/), "oscar@laesperanza.co");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));
    expect(
      await screen.findByText("Demasiados intentos. Espere un rato y vuelva a probar."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviarme el enlace" })).toBeInTheDocument();
  });

  it("explains the way back without email when the server cannot say", async () => {
    server.use(
      http.get("*/v1/auth/password-reset", () => HttpResponse.error()),
    );
    renderForgot();
    expect(await screen.findByText(/Configuración → Usuarios/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviarme el enlace" })).not.toBeInTheDocument();
  });
});
