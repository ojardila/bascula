// SPDX-License-Identifier: MIT
/**
 * The support console's remaining paths: an operator who also belongs to a
 * farm, a web address somebody else already holds (seen before and after the
 * create call), the "Finca creada" notice closed with Escape, and a second
 * press on «Suspender» while the dialog is fading out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { FARM_ID, farms, resetDb } from "../../mocks/db";

vi.setConfig({ testTimeout: 30_000 });

const SUPER = "0192f3a0-0001-7000-8000-000000000009";
type User = ReturnType<typeof userEvent.setup>;

function renderConsole(withFarm = false) {
  const now = Date.now();
  setTokens({
    accessToken: withFarm
      ? `mock-access.${SUPER}.${FARM_ID}.${now}.${now + 900_000}`
      : `mock-access.${SUPER}.test`,
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

async function openCreate(user: User) {
  await screen.findByText("La Esperanza");
  await user.click(screen.getByRole("button", { name: "Crear finca" }));
  return screen.findByRole("dialog");
}

async function fillBasics(user: User, dialog: HTMLElement, slug: string) {
  await user.type(within(dialog).getByLabelText(/Nombre de la finca/), "El Cedro");
  const field = within(dialog).getByLabelText(/Dirección web de la finca/);
  await user.clear(field);
  await user.type(field, slug);
  await user.type(within(dialog).getByLabelText(/Precio por kilo/), "900");
  await user.type(within(dialog).getByLabelText(/Correo del dueño/), "nueva@example.com");
}

describe("SuperAdminPage — an operator who also has a farm", () => {
  it("offers to go to the farm and takes them there", async () => {
    const user = userEvent.setup();
    renderConsole(true);
    await screen.findByText("La Esperanza");
    await user.click(await screen.findByRole("button", { name: "Ir a la finca" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Crear finca" })).not.toBeInTheDocument(),
    );
  });
});

describe("SuperAdminPage — a web address already taken", () => {
  it("refuses before calling the server when the check already said it is taken", async () => {
    const user = userEvent.setup();
    let created = false;
    server.use(
      http.post("*/v1/admin/farms", () => {
        created = true;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderConsole();
    const dialog = await openCreate(user);
    await fillBasics(user, dialog, "la-esperanza");
    // The debounced check answers "taken" and the field says so.
    expect(
      await within(dialog).findByText("Esa dirección ya la tiene otra finca. Escriba otra."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Crear finca" }));
    expect(screen.queryByText("Finca creada")).not.toBeInTheDocument();
    expect(created).toBe(false);
  });

  it("shows the server's refusal of the address under the field", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/farm-slugs", () => HttpResponse.json({ slug: "el-cedro", available: true })),
      http.post("*/v1/admin/farms", () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "slug already taken", details: {} } },
          { status: 409 },
        ),
      ),
    );
    renderConsole();
    const dialog = await openCreate(user);
    await fillBasics(user, dialog, "el-cedro");
    await user.click(within(dialog).getByRole("button", { name: "Crear finca" }));
    expect(
      await within(dialog).findByText("Esa dirección ya la tiene otra finca. Escriba otra."),
    ).toBeInTheDocument();
  });
});

describe("SuperAdminPage — closing and double presses", () => {
  it("closes the «Finca creada» notice with Escape", async () => {
    const user = userEvent.setup();
    renderConsole();
    const dialog = await openCreate(user);
    await fillBasics(user, dialog, "el-cedro");
    await user.click(within(dialog).getByRole("button", { name: "Crear finca" }));
    expect(await screen.findByText("Finca creada")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Finca creada")).not.toBeInTheDocument());
  });

  it("ignores a second press on «Suspender» while the dialog closes", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.patch("*/v1/admin/farms/:id", () => {
        calls += 1;
        return undefined;
      }),
    );
    renderConsole();
    await user.click(await screen.findByRole("button", { name: "Acciones de El Mirador" }));
    await user.click(await screen.findByRole("menuitem", { name: "Suspender" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Suspender" });
    await user.click(confirm);
    await waitFor(() =>
      expect(farms.find((f) => f.name === "El Mirador")?.suspendedAt).not.toBeNull(),
    );
    // The farm is gone from the dialog; a late click must not send anything.
    const before = calls;
    fireEvent.click(confirm);
    expect(calls).toBe(before);
  });
});
