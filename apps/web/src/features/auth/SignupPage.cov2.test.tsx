// SPDX-License-Identifier: MIT
/** «Cree su finca»: a refusal that names no field shows only at the top. */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { resetDb } from "../../mocks/db";
import { server } from "../../mocks/node";
import { theme } from "../../theme";

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
  resetDb();
});

describe("SignupPage", () => {
  it("shows a server failure with no fields at the top of the form", async () => {
    server.use(
      http.post("*/v1/signup", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "boom", details: {} } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/empezar"]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </ThemeProvider>,
    );
    await user.type(await screen.findByLabelText(/Nombre de la finca/), "Finca Nueva Prueba");
    await user.type(screen.getByLabelText(/Su nombre/), "Oscar");
    await user.type(screen.getByLabelText(/^Correo/), "nuevo@example.com");
    await user.type(screen.getByLabelText(/^Clave/), "una-clave-larga");
    await user.click(screen.getByRole("button", { name: "Crear mi finca" }));
    expect(
      await screen.findByText("El servidor tuvo un problema. Intente de nuevo en un momento."),
    ).toBeInTheDocument();
  }, 20000);
});
