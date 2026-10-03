/**
 * The support console beyond creating a farm: filters, suspending and
 * reactivating, the checks on the new-farm form, and the three ways the
 * owner's account can come out of it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { farms, resetDb } from "../../mocks/db";

const SUPER = "0192f3a0-0001-7000-8000-000000000009";
type User = ReturnType<typeof userEvent.setup>;

function renderConsole() {
  setTokens({
    accessToken: `mock-access.${SUPER}.test`,
    refreshToken: `mock-refresh.${SUPER}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/admin/fincas"]}>
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
  invalidateRefs();
  localStorage.clear();
});

const refuse = (status: number, code: string) =>
  HttpResponse.json(
    { error: { code, message: code, details: {} } },
    { status },
  );

async function rowMenu(user: User, name: string) {
  await user.click(
    await screen.findByRole("button", { name: `Acciones de ${name}` }),
  );
}

async function openCreate(user: User) {
  await screen.findByText("La Esperanza");
  await user.click(screen.getByRole("button", { name: "Crear finca" }));
  return screen.findByRole("dialog");
}

describe("the farm list", () => {
  it("filters active and suspended farms", async () => {
    const user = userEvent.setup();
    renderConsole();
    expect(await screen.findByText("La Palma")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    expect(screen.queryByText("La Esperanza")).not.toBeInTheDocument();
    expect(screen.getByText("La Palma")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activas" }));
    expect(await screen.findByText("La Esperanza")).toBeInTheDocument();
    expect(screen.queryByText("La Palma")).not.toBeInTheDocument();
  }, 20000);

  it("suspends a farm after asking, and reactivates it", async () => {
    const user = userEvent.setup();
    renderConsole();
    await rowMenu(user, "El Mirador");
    await user.click(
      await screen.findByRole("menuitem", { name: "Suspender" }),
    );
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("¿Suspender El Mirador?"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await rowMenu(user, "El Mirador");
    await user.click(
      await screen.findByRole("menuitem", { name: "Suspender" }),
    );
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Suspender" }));
    await waitFor(() =>
      expect(
        farms.find((f) => f.name === "El Mirador")?.suspendedAt,
      ).not.toBeNull(),
    );

    await rowMenu(user, "La Palma");
    await user.click(
      await screen.findByRole("menuitem", { name: "Reactivar" }),
    );
    await waitFor(() =>
      expect(farms.find((f) => f.name === "La Palma")?.suspendedAt).toBeNull(),
    );
  }, 20000);

  it("shows a refused suspension or reactivation", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch("*/v1/admin/farms/:id", () => refuse(403, "FORBIDDEN")),
    );
    renderConsole();
    await rowMenu(user, "El Mirador");
    await user.click(
      await screen.findByRole("menuitem", { name: "Suspender" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Suspender",
      }),
    );
    expect(await screen.findByText(/no tiene permiso/)).toBeInTheDocument();
    await rowMenu(user, "La Palma");
    await user.click(
      await screen.findByRole("menuitem", { name: "Reactivar" }),
    );
    expect(await screen.findByText(/no tiene permiso/)).toBeInTheDocument();
  }, 20000);

  it("signs out", async () => {
    const user = userEvent.setup();
    renderConsole();
    await screen.findByText("La Esperanza");
    await user.click(screen.getByRole("button", { name: "Salir" }));
    expect(
      await screen.findByRole("button", { name: /Entrar/ }),
    ).toBeInTheDocument();
  }, 20000);
});

describe("the new-farm form", () => {
  it("checks the name, the price, the owner's email and the password", async () => {
    const user = userEvent.setup();
    renderConsole();
    const dialog = await openCreate(user);
    const submit = () =>
      user.click(within(dialog).getByRole("button", { name: "Crear finca" }));
    await submit();
    expect(
      await within(dialog).findByText("Escriba el nombre de la finca."),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/Nombre de la finca/),
      "El Roble",
    );
    await submit();
    expect(
      await within(dialog).findByText("Escriba cuánto paga por kilo."),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Precio por kilo/), "900");
    await submit();
    expect(
      await within(dialog).findByText("Escriba el correo del dueño."),
    ).toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/Correo del dueño/),
      "ana@example.com",
    );
    await user.type(within(dialog).getByLabelText(/Clave del dueño/), "corta");
    await submit();
    expect(
      await within(dialog).findByText(/al menos 10 caracteres/),
    ).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/Clave del dueño/));
    await user.type(
      within(dialog).getByLabelText(/Clave del dueño/),
      "una-clave-larga",
    );
    await submit();
    expect(await screen.findByText("Finca creada")).toBeInTheDocument();
    expect(
      screen.getByText("El dueño entra con la clave que usted escribió."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Entendido" }));
    await waitFor(() =>
      expect(screen.queryByText("Finca creada")).not.toBeInTheDocument(),
    );
  }, 30000);

  it("rejects a web address that is not valid", async () => {
    const user = userEvent.setup();
    renderConsole();
    const dialog = await openCreate(user);
    await user.type(
      within(dialog).getByLabelText(/Nombre de la finca/),
      "El Roble",
    );
    const slug = within(dialog).getByLabelText(/Dirección web de la finca/);
    await user.clear(slug);
    await user.type(slug, "-x-");
    await user.click(
      within(dialog).getByRole("button", { name: "Crear finca" }),
    );
    expect(screen.queryByText("Finca creada")).not.toBeInTheDocument();
  }, 20000);

  it("adds the farm to an existing account without touching its password", async () => {
    const user = userEvent.setup();
    renderConsole();
    const dialog = await openCreate(user);
    await user.type(
      within(dialog).getByLabelText(/Nombre de la finca/),
      "El Cedro",
    );
    await user.type(within(dialog).getByLabelText(/Precio por kilo/), "900");
    await user.type(
      within(dialog).getByLabelText(/Correo del dueño/),
      "oscar@laesperanza.co",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Crear finca" }),
    );
    expect(
      await screen.findByText(/Esa cuenta ya existía/),
    ).toBeInTheDocument();
  }, 20000);

  it("shows the server's refusal and can be closed", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/v1/admin/farms", () => refuse(403, "FORBIDDEN")));
    renderConsole();
    const dialog = await openCreate(user);
    await user.type(
      within(dialog).getByLabelText(/Nombre de la finca/),
      "El Cedro",
    );
    await user.type(within(dialog).getByLabelText(/Precio por kilo/), "900");
    await user.type(
      within(dialog).getByLabelText(/Correo del dueño/),
      "nueva@example.com",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Crear finca" }),
    );
    expect(
      await within(dialog).findByText(/no tiene permiso/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  }, 20000);
});
