/**
 * Gestión de usuarios.
 *
 * Two things are worth testing here and neither of them is the form.
 *
 * WHO MAY. `docs/diagramas/sistema.md` §3.3 puts user management in the owner
 * column and leaves the administrator's blank — stricter than
 * `casos-de-uso.md` reads on its own, and the same tightening that took prices
 * and deletion off the administrator. If that ever silently relaxes, an
 * administrator can hand somebody the payroll.
 *
 * WHAT IT SAYS WHEN THE SERVER CANNOT ANSWER. `/v1/users` does not exist yet.
 * The failure mode to avoid is not a crash — it is an empty table under
 * "Usuarios de la finca", which says this farm has nobody in it while somebody
 * is logged in reading it.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, within } from "@testing-library/react";
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
const ADMIN = "0192f3a0-0001-7000-8000-000000000002";

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

function renderUsers() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/configuracion/usuarios"]}>
        <AuthProvider>
          <Routes>
            <Route path="/configuracion/usuarios" element={<FarmUsersPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

describe("quién puede repartir accesos", () => {
  it("el dueño sí", async () => {
    renderUsers();
    expect(await screen.findByText("Gloria Betancur")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Invitar a alguien/ })).toBeEnabled();
  }, 20000);

  it("el administrador no, ni llegando por la URL", async () => {
    signIn(ADMIN);
    renderUsers();
    expect(
      await screen.findByText("No tiene permiso para gestionar los usuarios"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Invitar/ })).not.toBeInTheDocument();
  }, 20000);
});

describe("la lista", () => {
  it("dice quién no ha entrado nunca, en vez de inventarle una fecha", async () => {
    renderUsers();
    await screen.findByText("Gloria Betancur");
    // A 1 January 1970 in this column is a lie about somebody's activity.
    expect(screen.getAllByText("Nunca ha entrado").length).toBeGreaterThan(0);
  }, 20000);

  it("no deja cambiarle el rol al dueño ni a uno mismo", async () => {
    renderUsers();
    const row = (await screen.findByText("Oscar Jaramillo")).closest("tr")!;
    // The owner's row shows the role as text, with no control: a farm with no
    // owner, or an owner who has just demoted themselves, is a farm nobody can
    // administer. The server says the same.
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(row).getByText("Dueño")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Quitar acceso/ })).not.toBeInTheDocument();
  }, 20000);
});

describe("invitar", () => {
  it("crea la membresía con el rol elegido y la deja sin confirmar", async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText("Gloria Betancur");

    await user.click(screen.getByRole("button", { name: /Invitar a alguien/ }));
    const dialog = await screen.findByRole("dialog");

    // The role is chosen with its consequence next to it, not from two bare
    // words: this is the one form where the wrong option hands over the
    // payroll.
    expect(within(dialog).getByText(/No ve plata, ni saldos/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Correo"), "nuevo@laesperanza.co");
    await user.type(within(dialog).getByLabelText("Nombre"), "Elena Zapata");
    await user.click(within(dialog).getByRole("button", { name: /Enviar la invitación/ }));

    expect(await screen.findByText("Elena Zapata")).toBeInTheDocument();
    const row = screen.getByText("Elena Zapata").closest("tr")!;
    // `invited`, not `active`: the server owns the invitation and this app
    // never sees a password. Showing "Activo" would claim they can log in.
    expect(within(row).getByText("Invitado, sin confirmar")).toBeInTheDocument();
    expect(within(row).getByText("Nunca ha entrado")).toBeInTheDocument();
  }, 20000);

  it("quitar el acceso no borra a nadie, y lo dice", async () => {
    const user = userEvent.setup();
    renderUsers();
    const row = (await screen.findByText("Gloria Betancur")).closest("tr")!;

    await user.click(within(row).getByRole("button", { name: "Quitar acceso" }));
    const dialog = await screen.findByRole("dialog");
    // Every work record and settlement names the user that wrote it; a user id
    // that resolves to nothing turns an audit trail into a list of UUIDs.
    expect(
      within(dialog).getByText(/todo lo que registró sigue con su nombre/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Sí, quitar el acceso/ }));
    expect(await screen.findByText("Sin acceso")).toBeInTheDocument();
    expect(screen.getByText("Gloria Betancur")).toBeInTheDocument();
  }, 20000);
});

describe("cuando el servidor todavía no sirve la ruta", () => {
  it("lo dice y nombra lo que espera, en vez de una tabla vacía", async () => {
    // What the running server does today: `routes.go` has no `/v1/users`.
    server.use(
      http.get("*/v1/users", () =>
        HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "resource not found" } },
          { status: 404 },
        ),
      ),
    );
    renderUsers();

    expect(
      await screen.findByText("Esta parte todavía no está en el servidor"),
    ).toBeInTheDocument();
    expect(screen.getByText(/GET \/v1\/users/)).toBeInTheDocument();
    // No table at all. An empty one would say this farm has nobody in it.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // And no button that would post into a route that is not there.
    expect(screen.getByRole("button", { name: /Invitar a alguien/ })).toBeDisabled();
  }, 20000);
});
