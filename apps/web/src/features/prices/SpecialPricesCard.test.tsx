/**
 * Special kilo prices per lote and per person (phase 2).
 *
 *   1. the card says in plain words which price wins;
 *   2. the owner adds a price for a lote, sees what it moves, and it is stored;
 *   3. ending it is a dated entry, not a deletion;
 *   4. someone who is not the owner sees the prices and cannot change them;
 *   5. the rule the mock prices with is persona > lote > semana > finca.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SpecialPricesCard } from "./SpecialPricesCard";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderCard(canEdit = true) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <SpecialPricesCard canEdit={canEdit} />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

const tenant = () => db.tenantOf(db.FARM_ID)!;

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

describe("special kilo prices", () => {
  it("says which price wins, in plain words", async () => {
    renderCard();
    expect(await screen.findByText("¿Qué precio se paga?")).toBeInTheDocument();
    expect(screen.getByText("Puede hacerlo después")).toBeInTheDocument();
  });

  it("the owner gives a lote its own price from a Monday", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Precio especial para un lote" }));
    const dialog = await screen.findByRole("dialog");
    const plot = tenant().plots[0];

    await user.click(within(dialog).getByLabelText("¿Qué lote?"));
    await user.click(await screen.findByRole("option", { name: plot.name }));
    await user.type(within(dialog).getByLabelText("Precio especial por kilo en pesos"), "1200");
    await user.click(within(dialog).getByRole("button", { name: "Guardar precio especial" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const rows = tenant().specialPrices ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "lote", targetId: plot.id, priceCents: 120_000 });
    expect(await screen.findByText(/se paga a \$\s?1\.200 por kilo/)).toBeInTheDocument();
    expect(screen.getByText(plot.name)).toBeInTheDocument();
  });

  it("taking a price away is dated, and the history keeps it", async () => {
    const user = userEvent.setup();
    const plot = tenant().plots[0];
    tenant().specialPrices = [
      { kind: "lote", targetId: plot.id, validFrom: "2026-01-05", priceCents: 110_000, createdAt: new Date().toISOString() },
    ];
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Quitar" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Sí, quitar el precio" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const rows = tenant().specialPrices ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.priceCents === null)).toBe(true);
    expect(await screen.findByText("Sin precio especial esta semana")).toBeInTheDocument();
  });

  it("without the owner's permission there is nothing to press", async () => {
    const plot = tenant().plots[0];
    tenant().specialPrices = [
      { kind: "lote", targetId: plot.id, validFrom: "2026-01-05", priceCents: 110_000, createdAt: new Date().toISOString() },
    ];
    renderCard(false);
    expect(await screen.findByText(plot.name)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cambiar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Precio especial para un lote" })).not.toBeInTheDocument();
  });

  it("prices a kilo persona > lote > semana > finca", () => {
    const t = tenant();
    const plot = t.plots[0];
    const worker = t.workers[0];
    const week = "2026-08-24";
    const rec = { workerId: worker.id, plotIds: [plot.id] };
    const base = db.kiloPriceOf(t, rec, week);
    expect(["semana", "finca"]).toContain(base.source);
    t.specialPrices = [
      { kind: "lote", targetId: plot.id, validFrom: "2026-08-17", priceCents: 100_000, createdAt: "" },
    ];
    expect(db.kiloPriceOf(t, rec, week)).toEqual({ priceCents: 100_000, source: "lote" });
    t.specialPrices.push({ kind: "persona", targetId: worker.id, validFrom: "2026-08-24", priceCents: 130_000, createdAt: "" });
    expect(db.kiloPriceOf(t, rec, week)).toEqual({ priceCents: 130_000, source: "persona" });
    // The week before her price started still pays the lote's.
    expect(db.kiloPriceOf(t, rec, "2026-08-17")).toEqual({ priceCents: 100_000, source: "lote" });
  });
});
