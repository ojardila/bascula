/**
 * The sales screen's edges: a session the server refuses, a void the server
 * turns down, a confirmation clicked twice, a voided row that offers nothing,
 * and the two ways of backing out of a dialog.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { SalesPage } from "./SalesPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { theme } from "../../theme";
import { resetDb, FARM_ID } from "../../mocks/db";
import { server } from "../../mocks/node";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderSales() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/ventas"]}>
        <AuthProvider>
          <SalesPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  resetDb();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

type User = ReturnType<typeof userEvent.setup>;

async function openVoid(user: User) {
  await screen.findByText("Café pergamino seco");
  await user.click(screen.getAllByRole("button", { name: /^Acciones de/ })[0]);
  await user.click(
    await screen.findByRole("menuitem", { name: "Anular la venta" }),
  );
  return screen.findByRole("dialog");
}

describe("who may see the sales", () => {
  it("shows the permission screen when the server refuses the list", async () => {
    server.use(
      http.get("*/v1/sales", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderSales();
    expect(
      await screen.findByText("No tiene permiso para ver las ventas"),
    ).toBeInTheDocument();
  }, 20000);
});

describe("voiding a sale", () => {
  it("says why the server refused, and the message can be closed", async () => {
    server.use(
      http.delete("*/v1/sales/:id", () =>
        HttpResponse.json(
          { error: { code: "CONFLICT", message: "La venta ya estaba anulada." } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSales();
    const dialog = await openVoid(user);
    await user.click(
      within(dialog).getByRole("button", { name: "Anular la venta" }),
    );

    let alert: HTMLElement | null = null;
    await waitFor(() => {
      alert = document.querySelector<HTMLElement>(".MuiAlert-colorError");
      expect(alert).not.toBeNull();
    });
    // The dialog stays: nothing was voided, so there is nothing to close over.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(
      within(alert!).getByRole("button", { name: /close|cerrar/i, hidden: true }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  }, 30000);

  it("sends one void for a double click, and ignores a click on the closing dialog", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.delete("*/v1/sales/:id", async () => {
        calls += 1;
        await gate;
        return HttpResponse.json(
          { error: { code: "CONFLICT", message: "detenida" } },
          { status: 409 },
        );
      }),
    );
    const user = userEvent.setup();
    renderSales();
    const dialog = await openVoid(user);
    const confirm = within(dialog).getByRole("button", {
      name: "Anular la venta",
    });

    // Two clicks in the same task: the second finds the write in flight.
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release();
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(calls).toBe(1);
  }, 30000);

  it("does nothing when the confirmation fires after it was answered", async () => {
    let calls = 0;
    server.use(
      http.delete("*/v1/sales/:id", ({ params }) => {
        calls += 1;
        return HttpResponse.json({
          id: params.id,
          productId: "p",
          product: "Café pergamino seco",
          storageUnit: "bulto",
          customerId: null,
          customer: null,
          warehouseId: "w",
          warehouse: "Bodega principal",
          qty: 1,
          amountCents: 1,
          note: null,
          date: "2026-08-20T00:00:00Z",
          stockMoveId: null,
          voidedAt: "2026-08-21T00:00:00Z",
        });
      }),
    );
    const user = userEvent.setup();
    renderSales();
    const dialog = await openVoid(user);
    const confirm = within(dialog).getByRole("button", {
      name: "Anular la venta",
    });
    fireEvent.click(confirm);
    // The sale is cleared the moment the void lands; the dialog is still on
    // its way out, and a late click on it must not send anything.
    await waitFor(() =>
      expect(screen.queryByText(/vuelven a Bodega principal/)).toBeNull(),
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(calls).toBe(1);
  }, 30000);

  it("closes the confirmation on Cancelar without voiding", async () => {
    let calls = 0;
    server.use(
      http.delete("*/v1/sales/:id", () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const user = userEvent.setup();
    renderSales();
    const dialog = await openVoid(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(calls).toBe(0);
  }, 30000);

  it("offers no void on a sale that is already voided", async () => {
    const user = userEvent.setup();
    renderSales();
    await screen.findByText("Café pergamino seco");
    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    await waitFor(() =>
      expect(screen.getAllByText("anulada").length).toBeGreaterThan(0),
    );
    const voided = screen.getAllByText("anulada")[0].closest("tr")!;
    await user.click(
      within(voided).getByRole("button", { name: /^Acciones de/ }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: "Anular la venta" }),
    ).not.toBeInTheDocument();
  }, 30000);
});

describe("recording a sale", () => {
  it("closes the form on Cancelar", async () => {
    const user = userEvent.setup();
    renderSales();
    await user.click(
      await screen.findByRole("button", { name: "Registrar venta" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  }, 30000);

  it("still opens the form when the pickers could not be loaded", async () => {
    const boom = () =>
      HttpResponse.json(
        { error: { code: "INTERNAL", message: "boom" } },
        { status: 500 },
      );
    server.use(
      http.get("*/v1/products", boom),
      http.get("*/v1/customers", boom),
      http.get("*/v1/warehouses", boom),
    );
    const user = userEvent.setup();
    renderSales();
    await user.click(
      await screen.findByRole("button", { name: "Registrar venta" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: /^Producto/ }));
    // Nothing to pick from, rather than a crash.
    expect(
      screen.queryByRole("option", { name: /Café pergamino seco/ }),
    ).not.toBeInTheDocument();
  }, 30000);
});
