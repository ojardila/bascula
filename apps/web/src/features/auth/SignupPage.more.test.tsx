// SPDX-License-Identifier: MIT
/**
 * «Cree su finca», the paths `SignupPage.test.tsx` leaves out: every field
 * the form checks before sending, an address already taken, the server's
 * refusals (about the address and about anything else), and showing the
 * password.
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
import { invalidateRefs } from "../../api/refs";
import { resetDb } from "../../mocks/db";
import { server } from "../../mocks/node";
import { theme } from "../../theme";

function renderSignup() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/empezar"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function fillAll(
  user: ReturnType<typeof userEvent.setup>,
  farm = "Finca Nueva Prueba",
) {
  await user.type(await screen.findByLabelText(/Nombre de la finca/), farm);
  await user.type(screen.getByLabelText(/Su nombre/), "Oscar");
  await user.type(screen.getByLabelText(/^Correo/), "nuevo@example.com");
  await user.type(screen.getByLabelText(/^Clave/), "una-clave-larga");
}

const create = () => screen.getByRole("button", { name: "Crear mi finca" });

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
  resetDb();
});

describe("checked before sending", () => {
  it("names every missing field", async () => {
    const user = userEvent.setup();
    renderSignup();
    await screen.findByLabelText(/Nombre de la finca/);
    await user.click(create());
    expect(
      await screen.findByText("Escriba el nombre de la finca."),
    ).toBeInTheDocument();
    expect(screen.getByText("Escriba su nombre.")).toBeInTheDocument();
    expect(screen.getByText("Escriba su correo.")).toBeInTheDocument();
    expect(
      screen.getByText("La clave debe tener al menos 10 letras o números."),
    ).toBeInTheDocument();
  });

  it("refuses an email that is not one", async () => {
    const user = userEvent.setup();
    renderSignup();
    await fillAll(user);
    await user.clear(screen.getByLabelText(/^Correo/));
    await user.type(screen.getByLabelText(/^Correo/), "no-es-correo");
    await user.click(create());
    expect(
      await screen.findByText("Ese correo no parece válido. Revíselo."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Preparando su finca…")).not.toBeInTheDocument();
  });

  it("does not send an address another farm already has", async () => {
    const user = userEvent.setup();
    renderSignup();
    await fillAll(user, "La Esperanza");
    expect(
      await screen.findByText(
        "Esa dirección ya la tiene otra finca. Escriba otra.",
      ),
    ).toBeInTheDocument();
    await user.click(create());
    expect(screen.queryByText("Preparando su finca…")).not.toBeInTheDocument();
  });
});

describe("refused by the server", () => {
  it("puts an address refusal on the address", async () => {
    server.use(
      http.post("*/v1/signup", () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "slug already taken" } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSignup();
    await fillAll(user);
    await user.click(create());
    expect(
      await screen.findByText(
        "Esa dirección ya la tiene otra finca. Escriba otra.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector(".MuiAlert-colorError")).toBeNull();
  });

  it("shows any other refusal at the top, with its fields", async () => {
    server.use(
      http.post("*/v1/signup", () =>
        HttpResponse.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "Revise los datos",
              details: { fields: { "owner.name": "Ese nombre no sirve." } },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSignup();
    await fillAll(user);
    await user.click(create());
    expect(await screen.findByText("Ese nombre no sirve.")).toBeInTheDocument();
    expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull();
  });

  it("puts a 400 on the farm name under the farm name", async () => {
    server.use(
      http.post("*/v1/signup", () =>
        HttpResponse.json(
          {
            error: {
              code: "BAD_REQUEST",
              message: "farm.name contains control characters",
              details: {
                fields: {
                  "farm.name":
                    "Tiene caracteres no permitidos. Escríbalo en una sola línea.",
                },
              },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSignup();
    await fillAll(user);
    await user.click(create());
    expect(
      await screen.findByText(
        "Tiene caracteres no permitidos. Escríbalo en una sola línea.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Faltan datos o hay un dato mal escrito. Revise el formulario."),
    ).toBeInTheDocument();
  });
});

describe("lengths the server accepts", () => {
  it("caps names at 80 characters and the address at 254", async () => {
    renderSignup();
    expect(await screen.findByLabelText(/Nombre de la finca/)).toHaveAttribute(
      "maxlength",
      "80",
    );
    expect(screen.getByLabelText(/Su nombre/)).toHaveAttribute("maxlength", "80");
    expect(screen.getByLabelText(/^Correo/)).toHaveAttribute("maxlength", "254");
  });
});

describe("the password field", () => {
  it("can show and hide what was typed", async () => {
    const user = userEvent.setup();
    renderSignup();
    const field = await screen.findByLabelText(/^Clave/);
    expect(field).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Ver clave" }));
    expect(field).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Ocultar clave" }));
    expect(field).toHaveAttribute("type", "password");
  });
});
