/**
 * The «entrada o salida» dialog, the paths the inventory page tests leave
 * out: what it checks before sending, the direction of an adjustment, the
 * plot and crop a movement can name, the stickers, and a server refusal.
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
import { resetDb, FARM_ID } from "../../mocks/db";
import { server } from "../../mocks/node";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const SAVE = "Registrar entrada o salida";

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/inventario"]}>
        <AuthProvider>
          <InventoryPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  await screen.findByText("Café pergamino seco");
  await user.click(screen.getByRole("button", { name: SAVE }));
  return screen.findByRole("dialog");
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  field: RegExp,
  option: RegExp | string,
) {
  await user.click(within(dialog).getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function productAndWarehouse(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await pick(user, dialog, /Producto/, /Café pergamino seco/);
  await pick(user, dialog, /Bodega/, "Bodega principal");
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
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    expect(
      await within(dialog).findByText("Elija el producto."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Elija la bodega.")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Escriba la cantidad."),
    ).toBeInTheDocument();
  }, 30000);

  it("refuses a quantity that is not a number, and one that is not positive", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    const qty = within(dialog).getByLabelText(/^Cantidad/);
    await user.type(qty, "abc");
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    expect(
      await within(dialog).findByText("Escriba un número, por ejemplo 12,5."),
    ).toBeInTheDocument();
    await user.clear(qty);
    await user.type(qty, "0");
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    expect(
      await within(dialog).findByText(
        "Escriba la cantidad en positivo. El signo lo pone el motivo.",
      ),
    ).toBeInTheDocument();
  }, 30000);
});

describe("an adjustment", () => {
  it("asks whether it comes in or goes out, and takes it out", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await pick(user, dialog, /Motivo/, "Ajuste");
    await user.click(within(dialog).getByRole("button", { name: "Sale" }));
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "3");
    expect(within(dialog).getByText("25 bultos")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    expect(
      await within(dialog).findByText(/Un ajuste sin explicación/),
    ).toBeInTheDocument();
  }, 30000);

  it("creates a warehouse typed in for the first time", async () => {
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await pick(user, dialog, /Producto/, /Café pergamino seco/);
    await user.type(
      within(dialog).getByRole("combobox", { name: /Bodega/ }),
      "Bodega del alto",
    );
    await user.click(
      await screen.findByRole("option", { name: /Bodega del alto/ }),
    );
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "4");
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  }, 30000);
});

describe("what a movement can name", () => {
  it("sends the plot, the crop, the note and the stickers", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post("*/v1/stock/moves", async ({ request }) => {
        body = (await request.clone().json()) as Record<string, unknown>;
        return undefined;
      }),
    );
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await productAndWarehouse(user, dialog);
    await user.type(within(dialog).getByLabelText(/^Cantidad/), "10");
    await pick(user, dialog, /Lote/, /El Alto/);
    await user.click(within(dialog).getByRole("combobox", { name: /Cultivo/ }));
    const crops = await screen.findAllByRole("option");
    await user.click(crops[crops.length - 1]);
    await user.type(
      within(dialog).getByLabelText(/^Nota/),
      "Recogido el lunes",
    );
    await user.click(
      within(dialog).getByRole("switch", { name: /Imprimir stickers/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.plotId).toBe("0192f3a0-0004-7000-8000-000000000001");
    expect(body!.plotCropId).toBeTruthy();
    expect(body!.note).toBe("Recogido el lunes");
    expect(body!.labels).toBe(10);
  }, 30000);
});

describe("refused by the server", () => {
  it("shows why and keeps the dialog open", async () => {
    server.use(
      http.post("*/v1/stock/moves", () =>
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
    await user.click(within(dialog).getByRole("button", { name: SAVE }));
    await waitFor(() =>
      expect(dialog.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  }, 30000);
});
