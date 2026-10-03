// SPDX-License-Identifier: MIT
/**
 * The sale dialog, the paths `SalesPage.test.tsx` leaves out: what it checks
 * before sending, the server saying there is not that much in the warehouse
 * (with and without how much there is), any other refusal, and the optional
 * customer, warehouse and note typed in for the first time.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
const SAVE = "Registrar venta";

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/ventas"]}>
        <AuthProvider>
          <SalesPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  await screen.findByRole("heading", { name: "Ventas" });
  await user.click(await screen.findByRole("button", { name: SAVE }));
  return screen.findByRole("dialog");
}

async function productAndWarehouse(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.click(within(dialog).getByRole("combobox", { name: /^Producto/ }));
  await user.click(
    await screen.findByRole("option", { name: /Café pergamino seco/ }),
  );
  await user.click(
    within(dialog).getByRole("combobox", { name: /Bodega de la que sale/ }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Bodega principal" }),
  );
}

const save = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: SAVE });

function refuseSale(details: Record<string, unknown>) {
  server.use(
    http.post("*/v1/sales", () =>
      HttpResponse.json(
        {
          error: { code: "INSUFFICIENT_STOCK", message: "not enough", details },
        },
        { status: 409 },
      ),
    ),
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

describe("checked before sending", () => {
  it("names what is missing", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.click(save(dialog));
    expect(
      await within(dialog).findByText("Elija el producto que se vendió."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Elija de qué bodega salió."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Escriba la cantidad."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Escriba el valor de la venta."),
    ).toBeInTheDocument();
  }, 30000);

  it("refuses numbers that are not numbers", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "abc");
    await user.type(within(dialog).getByLabelText(/^Valor total/), "xyz");
    await user.click(save(dialog));
    expect(
      await within(dialog).findByText("Escriba un número, por ejemplo 12,5."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Escriba un número, por ejemplo 1.250.000."),
    ).toBeInTheDocument();
  }, 30000);

  it("refuses zero", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "0");
    await user.type(within(dialog).getByLabelText(/^Valor total/), "0");
    await user.click(save(dialog));
    await waitFor(() =>
      expect(
        within(dialog).getAllByText("Tiene que ser mayor que cero."),
      ).toHaveLength(2),
    );
  }, 30000);
});

describe("refused by the server", () => {
  it("says how much the warehouse holds when the server says so", async () => {
    refuseSale({ onHand: 3 });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "2");
    await user.type(within(dialog).getByLabelText(/^Valor total/), "100000");
    await user.click(save(dialog));
    expect(
      await within(dialog).findByText(/En bodega hay 3\./),
    ).toBeInTheDocument();
  }, 30000);

  it("says only that there is not enough when it does not", async () => {
    refuseSale({});
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "2");
    await user.type(within(dialog).getByLabelText(/^Valor total/), "100000");
    await user.click(save(dialog));
    await waitFor(() =>
      expect(dialog.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(
      dialog.querySelector(".MuiAlert-colorError")!.textContent,
    ).not.toMatch(/En bodega hay/);
  }, 30000);

  it("shows any other refusal as it is", async () => {
    server.use(
      http.post("*/v1/sales", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "2");
    await user.type(within(dialog).getByLabelText(/^Valor total/), "100000");
    await user.click(save(dialog));
    await waitFor(() =>
      expect(dialog.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  }, 30000);
});

describe("typed in for the first time", () => {
  it("sends a new customer by name, a new warehouse and a note", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("*/v1/sales", async ({ request }) => {
        body = (await request.clone().json()) as Record<string, unknown>;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.click(
      within(dialog).getByRole("combobox", { name: /^Producto/ }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Café pergamino seco/ }),
    );
    await user.type(
      within(dialog).getByRole("combobox", { name: /Bodega de la que sale/ }),
      "Bodega del alto",
    );
    await user.click(
      await screen.findByRole("option", { name: /Bodega del alto/ }),
    );
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "1");
    await user.type(within(dialog).getByLabelText(/^Valor total/), "100000");
    await user.type(
      within(dialog).getByRole("combobox", { name: /Cliente/ }),
      "Don Ramiro Nuevo",
    );
    await user.click(
      await screen.findByRole("option", { name: /Don Ramiro Nuevo/ }),
    );
    await user.type(within(dialog).getByLabelText(/^Nota/), "Pagó en efectivo");
    await user.click(save(dialog));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.customer).toBe("Don Ramiro Nuevo");
    expect(body!.note).toBe("Pagó en efectivo");
  }, 30000);
});
