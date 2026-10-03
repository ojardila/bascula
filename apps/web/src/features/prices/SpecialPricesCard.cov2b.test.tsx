// SPDX-License-Identifier: MIT
/**
 * Special prices, the last edges: a history entry that ended the special
 * price, a person with no last name, a lote that was not chosen, an impact
 * the server could not compute, and the dialog on a phone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { SpecialPricesCard } from "./SpecialPricesCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;
const realMatchMedia = window.matchMedia;

function renderCard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <SpecialPricesCard canEdit />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("the history", () => {
  it("names the week a special price was ended", async () => {
    const plot = tenant().plots.find((p) => p.deletedAt === null)!;
    tenant().specialPrices = [
      { kind: "lote", targetId: plot.id, validFrom: "2026-01-05", priceCents: 90_000, createdAt: "" },
      { kind: "lote", targetId: plot.id, validFrom: "2026-02-02", priceCents: null, createdAt: "" },
    ];
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Ver historial (2)" }));
    expect(
      await screen.findByText((_, el) =>
        el?.tagName === "P" && /^Desde el .*: sin precio especial$/.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
  });
});

describe("the dialog", () => {
  it("lists a person with no last name by the first name alone", async () => {
    const worker = tenant().workers.find((w) => w.deletedAt == null && w.kind !== "equipo")!;
    worker.lastName = null as unknown as string;
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", { name: "Precio especial para una persona" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("¿Qué persona?"));
    expect(await screen.findByRole("option", { name: worker.name })).toBeInTheDocument();
  });

  it("asks for the lote, and shows no impact when it cannot be computed", async () => {
    server.use(
      http.get("*/v1/prices/special/:kind/:id/:monday/impact", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "x" } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", { name: "Precio especial para un lote" }),
    );
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Guardar precio especial" });
    await user.click(save);
    expect(await within(dialog).findByText("Escoja el lote.")).toBeInTheDocument();

    await user.click(within(dialog).getByLabelText("¿Qué lote?"));
    await user.click(await screen.findByRole("option", { name: "El Alto" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(within(dialog).queryByText(/^Desde ese lunes|^Todavía no hay pesadas/)).not.toBeInTheDocument();
  });

  it("on a phone, fills the screen with full-width buttons", async () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const user = userEvent.setup();
    renderCard();
    await user.click(
      await screen.findByRole("button", { name: "Precio especial para un lote" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toHaveClass(
      "MuiButton-fullWidth",
    );
  });
});
