/**
 * The farm price card, the states `BasePriceCard.test.tsx` leaves out: a price
 * the app set and nobody confirmed yet, how the impact reads with nothing
 * settled and one week on its own price, and the alerts that can be closed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { BasePriceCard } from "./BasePriceCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderCard() {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <BasePriceCard />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const priceField = () => screen.getByLabelText("Precio por kilo en pesos");
const saveButton = () =>
  screen.getByRole("button", { name: /Guardar precio|Confirmar precio/ });

function serveState(
  confirmed: boolean,
  history: { validFrom: string; priceCents: number }[],
) {
  server.use(
    http.get("*/v1/prices/base", () =>
      HttpResponse.json({
        currentCents: 100000,
        confirmed,
        thisWeek: "2026-01-05",
        history,
      }),
    ),
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

describe("a price nobody confirmed yet", () => {
  it("asks to confirm it, and confirming it saves it", async () => {
    const user = userEvent.setup();
    serveState(false, [{ validFrom: "2000-01-03", priceCents: 100000 }]);
    server.use(
      http.put("*/v1/prices/base/:monday", () =>
        HttpResponse.json({
          currentCents: 100000,
          confirmed: true,
          thisWeek: "2026-01-05",
          history: [{ validFrom: "2000-01-03", priceCents: 100000 }],
        }),
      ),
    );
    renderCard();
    expect(await screen.findByText("Sin confirmar")).toBeInTheDocument();
    expect(
      screen.getByText(/Este precio lo puso la aplicación/),
    ).toBeInTheDocument();
    await waitFor(() => expect(priceField()).toHaveValue("1.000"));
    expect(
      screen.getByRole("button", { name: "Guardar precio" }),
    ).toBeInTheDocument();

    await user.click(saveButton());
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Sí, guardar el precio" }),
    );
    const done = await screen.findByText(/Listo: \$1\.000 por kilo/);
    await user.click(
      within(done.closest(".MuiAlert-root") as HTMLElement).getByRole(
        "button",
        {
          name: /close|cerrar/i,
          hidden: true,
        },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Listo:/)).not.toBeInTheDocument(),
    );
  });

  it("treats a Monday before any price as a change", async () => {
    const user = userEvent.setup();
    serveState(true, [{ validFrom: "2026-03-02", priceCents: 100000 }]);
    renderCard();
    await waitFor(() => expect(priceField()).toHaveValue("1.000"));
    await user.click(saveButton());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("what saving moves", () => {
  it("says nothing settled changes and one week keeps its own price", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/prices/base/:monday/impact", () =>
        HttpResponse.json({
          unsettledRecords: 2,
          settledRecords: 0,
          weeksWithOwnPrice: 1,
        }),
      ),
    );
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.clear(priceField());
    await user.type(priceField(), "1234");
    expect(
      await screen.findByText(
        /2 pesadas sin liquidar toman este precio\. Lo ya liquidado no cambia\. Una semana tiene su propio precio y lo conserva\./,
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about it when the impact cannot be read", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/prices/base/:monday/impact", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.clear(priceField());
    await user.type(priceField(), "1234");
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(/sin liquidar to/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Todavía no hay pesadas/),
    ).not.toBeInTheDocument();
  });
});

describe("a refused save", () => {
  it("can be dismissed", async () => {
    const user = userEvent.setup();
    server.use(
      http.put("*/v1/prices/base/:monday", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "Precio raro" } },
          { status: 400 },
        ),
      ),
    );
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.clear(priceField());
    await user.type(priceField(), "1700");
    await user.click(saveButton());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Sí, guardar el precio",
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(
      within(
        document.querySelector(".MuiAlert-colorError") as HTMLElement,
      ).getByRole("button", {
        name: /close|cerrar/i,
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector(".MuiAlert-colorError")).toBeNull(),
    );
  });
});
