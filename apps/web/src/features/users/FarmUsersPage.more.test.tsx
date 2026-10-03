// SPDX-License-Identifier: MIT
/**
 * The rest of farm user management: changing a role, a refused change or
 * revocation, an invitation the server turns down, and the way back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { FarmUsersPage } from "./FarmUsersPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderUsers() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/configuracion/usuarios"]}>
        <AuthProvider>
          <Routes>
            <Route path="/configuracion/usuarios" element={<FarmUsersPage />} />
            <Route path="/configuracion" element={<div>configuración</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** The page always carries an info alert or two; the red one is the answer. */
async function errorAlert(): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector<HTMLElement>(".MuiAlert-colorError");
    expect(found).not.toBeNull();
  });
  return found!;
}

const boom = () =>
  HttpResponse.json(
    { error: { code: "INTERNAL", message: "boom" } },
    { status: 500 },
  );

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

async function gloriaRow() {
  return (await screen.findByText("Gloria Betancur")).closest("tr")!;
}

describe("changing somebody's role", () => {
  it("saves the new role and shows it after reloading the list", async () => {
    let sent: unknown = null;
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "PATCH" && request.url.includes("/v1/users/")) {
        sent = await request.clone().json();
      }
    });
    const user = userEvent.setup();
    renderUsers();
    const row = await gloriaRow();
    await user.click(within(row).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Pesador" }));
    await waitFor(() =>
      expect(sent).toMatchObject({ role: expect.any(String) }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByText("Gloria Betancur").closest("tr")!).getByRole(
          "combobox",
        ),
      ).toHaveTextContent("Pesador"),
    );
    server.events.removeAllListeners();
  }, 20000);

  it("says why when the server refuses, and the message can be closed", async () => {
    server.use(http.patch("*/v1/users/:id", boom));
    const user = userEvent.setup();
    renderUsers();
    const row = await gloriaRow();
    await user.click(within(row).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Pesador" }));
    const alert = await errorAlert();
    await user.click(
      within(alert).getByRole("button", { name: /close|cerrar/i }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  }, 20000);
});

describe("removing access", () => {
  it("can be called off", async () => {
    const user = userEvent.setup();
    renderUsers();
    const row = await gloriaRow();
    await user.click(
      within(row).getByRole("button", { name: "Quitar acceso" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      within(await gloriaRow()).queryByText("Sin acceso"),
    ).not.toBeInTheDocument();
  }, 20000);

  it("says why when the server refuses", async () => {
    server.use(http.delete("*/v1/users/:id", boom));
    const user = userEvent.setup();
    renderUsers();
    const row = await gloriaRow();
    await user.click(
      within(row).getByRole("button", { name: "Quitar acceso" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: /Sí, quitar el acceso/ }),
    );
    expect(await errorAlert()).toBeInTheDocument();
    expect(screen.queryByText("Sin acceso")).not.toBeInTheDocument();
  }, 20000);
});

describe("an invitation the server turns down", () => {
  it("keeps the dialog open with the reason, for the chosen role", async () => {
    let sent: { role?: string } | null = null;
    server.use(
      http.post("*/v1/users", async ({ request }) => {
        sent = (await request.json()) as { role?: string };
        return HttpResponse.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "invalid",
              details: { fields: { email: "Ese correo ya tiene acceso." } },
            },
          },
          { status: 422 },
        );
      }),
    );
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText("Gloria Betancur");
    await user.click(screen.getByRole("button", { name: /Invitar a alguien/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("radio", { name: "Administrador" }),
    );
    await user.click(within(dialog).getByText("Pesador"));
    await user.type(
      within(dialog).getByLabelText("Correo"),
      "gloria@laesperanza.co",
    );
    await user.type(within(dialog).getByLabelText("Nombre"), "Gloria Otra");
    await user.click(
      within(dialog).getByRole("button", { name: /Enviar la invitación/ }),
    );
    expect(
      await within(dialog).findByText("Ese correo ya tiene acceso."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    expect(sent!.role).toMatch(/weigher|pesador/i);
  }, 20000);
});

describe("around the page", () => {
  it("goes back to the configuration", async () => {
    const user = userEvent.setup();
    renderUsers();
    await user.click(
      await screen.findByRole("button", { name: "Configuración" }),
    );
    expect(await screen.findByText("configuración")).toBeInTheDocument();
  }, 20000);

  it("shows the permission screen when the server says no", async () => {
    server.use(
      http.get("*/v1/users", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderUsers();
    expect(
      await screen.findByText(/gestionar los usuarios/),
    ).toBeInTheDocument();
  }, 20000);
});
