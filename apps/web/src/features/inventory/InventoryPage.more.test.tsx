// SPDX-License-Identifier: MIT
/**
 * Inventory, the paths around the derived-stock rule: opening the product
 * form and the movement dialog from a row, taking a product out of use and
 * back, and what it says when the server refuses.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { InventoryPage } from "./InventoryPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { resetDb, FARM_ID } from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const PRODUCT = "Café pergamino seco";

function renderInventory() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/inventario"]}>
        <AuthProvider>
          <InventoryPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const boom = () =>
  HttpResponse.json({ error: { code: "BAD_REQUEST", message: "bad" } }, { status: 400 });

const errorAlert = () => document.querySelector<HTMLElement>(".MuiAlert-colorError");

beforeEach(() => {
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function rowAction(user: User, action: string) {
  await user.click(await screen.findByRole("button", { name: `Acciones de ${PRODUCT}` }));
  await user.click(await screen.findByRole("menuitem", { name: action }));
}

async function closeDialog(user: User) {
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("from a product row", () => {
  it("opens the product form by clicking the row, and closes it", async () => {
    const user = userEvent.setup();
    renderInventory();
    await user.click(await screen.findByText(PRODUCT));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await closeDialog(user);
  }, 20000);

  it("opens the movement dialog for that product, and closes it", async () => {
    const user = userEvent.setup();
    renderInventory();
    await rowAction(user, "Registrar entrada o salida");
    expect(
      await screen.findByText("Registrar una entrada o una salida"),
    ).toBeInTheDocument();
    await closeDialog(user);
  }, 20000);
});

describe("taking a product out of use and back", () => {
  it("deactivates it and reactivates it", async () => {
    const user = userEvent.setup();
    renderInventory();
    await rowAction(user, "Dar de baja");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Dar de baja" }),
    );
    await waitFor(() => expect(screen.queryByText(PRODUCT)).not.toBeInTheDocument());

    await user.click(await screen.findByRole("button", { name: "Inactivas" }));
    await rowAction(user, "Reactivar");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Reactivar" }),
    );
    await waitFor(() => expect(screen.queryByText(PRODUCT)).not.toBeInTheDocument());
    expect(errorAlert()).toBeNull();
  }, 30000);

  it("says why a deactivation was refused, and the message closes", async () => {
    server.use(http.patch("*/v1/products/:id", boom));
    const user = userEvent.setup();
    renderInventory();
    await rowAction(user, "Dar de baja");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Dar de baja" }),
    );
    await waitFor(() => expect(errorAlert()).not.toBeNull());
    await user.click(
      within(errorAlert()!).getByRole("button", { name: /close|cerrar/i, hidden: true }),
    );
    await waitFor(() => expect(errorAlert()).toBeNull());
  }, 30000);

  it("says why a reactivation was refused", async () => {
    const user = userEvent.setup();
    renderInventory();
    await rowAction(user, "Dar de baja");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Dar de baja" }),
    );
    await waitFor(() => expect(screen.queryByText(PRODUCT)).not.toBeInTheDocument());
    server.use(http.patch("*/v1/products/:id", boom));
    await user.click(await screen.findByRole("button", { name: "Inactivas" }));
    await rowAction(user, "Reactivar");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Reactivar" }),
    );
    await waitFor(() => expect(errorAlert()).not.toBeNull());
  }, 30000);
});

describe("the ins and outs", () => {
  it("says why a correction was refused", async () => {
    server.use(http.post("*/v1/stock/moves/:id/reverse", boom));
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText(PRODUCT);
    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));
    const buttons = await screen.findAllByRole("button", {
      name: /^Corregir la entrada o salida/,
    });
    await user.click(buttons[0]);
    await waitFor(() => expect(errorAlert()).not.toBeNull());
  }, 30000);

  it("offers to record the first one when there is none", async () => {
    server.use(http.get("*/v1/stock/moves", () => HttpResponse.json({ items: [], total: 0 })));
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText(PRODUCT);
    await user.click(screen.getByRole("tab", { name: "Entradas y salidas" }));
    await user.click(await screen.findByRole("button", { name: "Registrar el primero" }));
    expect(
      await screen.findByText("Registrar una entrada o una salida"),
    ).toBeInTheDocument();
    await closeDialog(user);
  }, 30000);
});

describe("who may see it", () => {
  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/products", () =>
        HttpResponse.json({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }),
      ),
    );
    renderInventory();
    expect(await screen.findByText(/ver el inventario/)).toBeInTheDocument();
  }, 20000);
});
