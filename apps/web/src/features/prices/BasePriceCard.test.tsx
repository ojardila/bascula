/**
 * The farm's kilo price card: confirming the seeded price, changing it from a
 * Monday with its impact spelled out, the guard against a price in cents, and
 * the errors on the way.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { BasePriceCard, formatMondayLong } from "./BasePriceCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderCard(onSaved?: () => void) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <BasePriceCard onSaved={onSaved} />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const priceField = () => screen.getByLabelText("Precio por kilo en pesos");

function serveImpact(
  unsettledRecords: number,
  settledRecords: number,
  weeksWithOwnPrice: number,
) {
  server.use(
    http.get("*/v1/prices/base/:monday/impact", () =>
      HttpResponse.json({
        unsettledRecords,
        settledRecords,
        weeksWithOwnPrice,
      }),
    ),
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
});

describe("formatMondayLong", () => {
  it("writes a Monday the way the card says it", () => {
    expect(formatMondayLong("2026-01-05")).toBe("lunes 5 ene 2026");
  });
});

describe("the farm price card", () => {
  it("changes the price from this week, with what it moves, and calls back", async () => {
    const user = userEvent.setup();
    let saved = 0;
    serveImpact(3, 2, 1);
    renderCard(() => saved++);
    await waitFor(() => expect(priceField()).not.toBeDisabled());

    await user.clear(priceField());
    await user.type(priceField(), "1250");
    expect(priceField()).toHaveValue("1.250");
    expect(screen.getByText(/20 kg ×/)).toBeInTheDocument();
    expect(
      await screen.findByText(
        /3 pesadas sin liquidar toman este precio\. 2 pesadas ya liquidadas no cambian\. Una semana tiene su propio precio y lo conserva\./,
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Guardar precio|Confirmar precio/ }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Sí, guardar el precio" }),
    );
    expect(
      await screen.findByText(/Listo: .* por kilo desde el lunes/),
    ).toBeInTheDocument();
    expect(saved).toBe(1);
    expect(screen.getByText("Historial del precio")).toBeInTheDocument();
  });

  it("speaks of one record and several weeks in the right number", async () => {
    const user = userEvent.setup();
    serveImpact(1, 1, 2);
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.clear(priceField());
    await user.type(priceField(), "999");
    expect(
      await screen.findByText(
        /1 pesada sin liquidar toma este precio\. 1 pesada ya liquidada no cambia\. 2 semanas tienen su propio precio y lo conservan\./,
      ),
    ).toBeInTheDocument();
  });

  it("says when nothing has been weighed from that Monday yet", async () => {
    const user = userEvent.setup();
    serveImpact(0, 0, 0);
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.clear(priceField());
    await user.type(priceField(), "1400");
    expect(
      await screen.findByText(/Todavía no hay pesadas desde ese día/),
    ).toBeInTheDocument();
  });

  it("refuses an empty price and one that looks like cents", async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    const save = () =>
      screen.getByRole("button", { name: /Guardar precio|Confirmar precio/ });

    await user.clear(priceField());
    await user.click(save());
    expect(
      screen.getByText("Escriba el precio en pesos. Por ejemplo: 1.000"),
    ).toBeInTheDocument();

    await user.type(priceField(), "50");
    await user.click(save());
    expect(screen.getByText(/es muy poco/)).toBeInTheDocument();
  });

  it("can pick another Monday from the list", async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.click(screen.getByLabelText("Desde"));
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(13);
    expect(
      screen.getByRole("option", { name: /\(esta semana\)/ }),
    ).toBeInTheDocument();
    await user.click(options[0]);
    await user.clear(priceField());
    await user.type(priceField(), "1300");
    await user.click(
      screen.getByRole("button", { name: /Guardar precio|Confirmar precio/ }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Cancelar|No/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("shows the server's refusal when saving fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.put("*/v1/prices/base/:monday", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderCard();
    await waitFor(() => expect(priceField()).not.toBeDisabled());
    await user.clear(priceField());
    await user.type(priceField(), "1700");
    await user.click(
      screen.getByRole("button", { name: /Guardar precio|Confirmar precio/ }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Sí, guardar el precio",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").some((a) => a.className.includes("Error")),
      ).toBe(true),
    );
  });

  it("says it could not read the price", async () => {
    server.use(
      http.get("*/v1/prices/base", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "x" } },
          { status: 500 },
        ),
      ),
    );
    renderCard();
    expect(
      await screen.findByText(/No se pudo leer el precio de la finca/),
    ).toBeInTheDocument();
  });

  it("tells the owner the price is already that one", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/prices/base", () =>
        HttpResponse.json({
          currentCents: 100000,
          confirmed: true,
          thisWeek: "2026-01-05",
          history: [
            { validFrom: "2026-03-02", priceCents: 120000 },
            { validFrom: "2026-01-05", priceCents: 100000 },
            { validFrom: "2000-01-03", priceCents: 90000 },
          ],
        }),
      ),
    );
    renderCard();
    await waitFor(() => expect(priceField()).toHaveValue("1.000"));
    expect(screen.getByText("Desde el principio")).toBeInTheDocument();
    expect(screen.getByText(/Empieza el lunes/)).toBeInTheDocument();
    expect(screen.getByText("Se paga hoy")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar precio" }));
    expect(
      screen.getByText(/Ese ya es el precio desde el lunes 5 ene 2026/),
    ).toBeInTheDocument();
  });
});
