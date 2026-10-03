/**
 * The week price page, the paths `WeekPricePage.test.tsx` leaves out: a
 * price of zero, a refused save, a week that cannot be read or may not be
 * seen, and moving to another week from the picker and from the history.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WeekPricePage } from "./WeekPricePage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderPrices() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/precio-semana"]}>
        <AuthProvider>
          <WeekPricePage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const ready = () => screen.findByRole("heading", { name: "Precio del kilo" });
const priceInput = () => screen.getByLabelText(/Precio nuevo por kilo/);
const review = () => screen.getByRole("button", { name: /Revisar y fijar/ });

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

describe("the new price", () => {
  it("has to be more than zero", async () => {
    const user = userEvent.setup();
    renderPrices();
    await ready();
    await user.type(priceInput(), "0");
    await user.click(review());
    expect(
      await screen.findByText("El precio tiene que ser mayor que cero."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  }, 20000);

  it("shows the server's refusal, which can be dismissed", async () => {
    const user = userEvent.setup();
    server.use(
      http.put("*/v1/prices/weeks/:monday", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "No se puede" } },
          { status: 400 },
        ),
      ),
    );
    renderPrices();
    await ready();
    await user.type(priceInput(), "900");
    await user.click(review());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Fijar en/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    const alert = await waitFor(() => {
      const el = document.querySelector(".MuiAlert-colorError");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await user.click(
      within(alert).getByRole("button", {
        name: /close|cerrar/i,
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  }, 20000);

  it("closes the confirmation with Escape without saving", async () => {
    const user = userEvent.setup();
    let puts = 0;
    server.use(
      http.put("*/v1/prices/weeks/:monday", () => {
        puts++;
        return undefined;
      }),
    );
    renderPrices();
    await ready();
    await user.type(priceInput(), "900");
    await user.click(review());
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(puts).toBe(0);
  }, 20000);

  it("can close the saved notice", async () => {
    const user = userEvent.setup();
    renderPrices();
    await ready();
    await user.type(priceInput(), "900");
    await user.click(review());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Fijar en/ }));
    const notice = await screen.findByText(
      /La recolección de esa semana que todavía/,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(
      within(notice.closest(".MuiAlert-root") as HTMLElement).getByRole(
        "button",
        {
          name: /close|cerrar/i,
          hidden: true,
        },
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/La recolección de esa semana que todavía/),
      ).not.toBeInTheDocument(),
    );
  }, 20000);
});

describe("another week", () => {
  it("is picked from the list", async () => {
    const user = userEvent.setup();
    renderPrices();
    await ready();
    await user.type(priceInput(), "900");
    await user.click(screen.getByRole("combobox", { name: "Semana" }));
    const options = await screen.findAllByRole("option");
    await user.click(options[options.length - 1]);
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(priceInput()).toHaveValue("");
  }, 20000);

  it("is picked from the history table", async () => {
    const user = userEvent.setup();
    renderPrices();
    await ready();
    const header = await screen.findByRole("columnheader", {
      name: "Precio por kilo",
    });
    const table = header.closest("table") as HTMLElement;
    await waitFor(() =>
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(3),
    );
    const rows = within(table).getAllByRole("row");
    await user.click(rows[rows.length - 1]);
    await waitFor(() =>
      expect(rows[rows.length - 1]).toHaveClass("Mui-selected"),
    );
  }, 20000);
});

describe("a week that cannot be read", () => {
  it("says no figure is zero", async () => {
    server.use(
      http.get("*/v1/prices/weeks/:monday", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderPrices();
    expect(
      await screen.findByText(/No se pudo consultar el precio de la semana/),
    ).toBeInTheDocument();
  }, 20000);

  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/prices/weeks/:monday", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderPrices();
    expect(
      await screen.findByText(/ver el precio de la semana/),
    ).toBeInTheDocument();
  }, 20000);
});
