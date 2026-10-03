/**
 * The farm price card's last edges: the impact with nothing on its own week,
 * an empty field on a price nobody confirmed, a farm whose week the server
 * did not send, and the tour's «Continuar» on this card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { BasePriceCard } from "./BasePriceCard";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";
import { TourContext, type TourContextValue } from "../onboarding/TourContext";

type Action = () => Promise<boolean> | boolean;

function renderCard(tour?: Partial<TourContextValue>) {
  const card: ReactElement = <BasePriceCard />;
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          {tour ? (
            <TourContext.Provider value={tour as TourContextValue}>{card}</TourContext.Provider>
          ) : (
            card
          )}
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function fakeTour() {
  const actions = new Map<string, Action>();
  const note = vi.fn();
  const tour: Partial<TourContextValue> = {
    note,
    registerAction: (name: string, fn: Action) => {
      actions.set(name, fn);
      return () => actions.delete(name);
    },
  } as unknown as Partial<TourContextValue>;
  return { tour, note, run: () => actions.get("save-base-price")!() };
}

function serveState(state: {
  confirmed?: boolean;
  thisWeek?: string | null;
  currentCents?: number;
}) {
  server.use(
    http.get("*/v1/prices/base", () =>
      HttpResponse.json({
        currentCents: state.currentCents ?? 100000,
        confirmed: state.confirmed ?? true,
        thisWeek: state.thisWeek === undefined ? "2026-01-05" : state.thisWeek,
        history: [{ validFrom: "2000-01-03", priceCents: 100000 }],
      }),
    ),
  );
}

const priceField = () => screen.getByLabelText("Precio por kilo en pesos");

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});

describe("BasePriceCard edges", () => {
  it("with no week on its own price, the impact only speaks of the settled", async () => {
    const user = userEvent.setup();
    serveState({});
    server.use(
      http.get("*/v1/prices/base/:monday/impact", () =>
        HttpResponse.json({ unsettledRecords: 4, settledRecords: 2, weeksWithOwnPrice: 0 }),
      ),
    );
    renderCard();
    await waitFor(() => expect(priceField()).toHaveValue("1.000"));
    await user.clear(priceField());
    await user.type(priceField(), "1200");
    const impact = await screen.findByText(/2 pesadas ya liquidadas no cambian\./);
    expect(impact).not.toHaveTextContent(/semanas tienen su propio precio/);
    expect(impact).not.toHaveTextContent(/Una semana tiene/);
  }, 20000);

  it("an emptied field on an unconfirmed price offers to confirm, and asks for a price", async () => {
    const user = userEvent.setup();
    serveState({ confirmed: false });
    renderCard();
    await waitFor(() => expect(priceField()).toHaveValue("1.000"));
    await user.clear(priceField());
    const confirm = screen.getByRole("button", { name: "Confirmar precio" });
    await user.click(confirm);
    expect(
      await screen.findByText("Escriba el precio en pesos. Por ejemplo: 1.000"),
    ).toBeInTheDocument();
  }, 20000);

  it("without a week from the server, confirming does not save anything", async () => {
    const user = userEvent.setup();
    let puts = 0;
    serveState({ thisWeek: null });
    server.use(
      http.put("*/v1/prices/base/:monday", () => {
        puts++;
        return HttpResponse.json({});
      }),
    );
    renderCard();
    await waitFor(() => expect(priceField()).toHaveValue("1.000"));
    await user.click(screen.getByRole("button", { name: "Guardar precio" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Desde el lunes elegido.");
    await user.click(screen.getByRole("button", { name: "Sí, guardar el precio" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(puts).toBe(0);
  }, 20000);

  describe("the tour's «Continuar»", () => {
    it("refuses while the price has not loaded", async () => {
      server.use(
        http.get("*/v1/prices/base", () =>
          HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
        ),
      );
      const t = fakeTour();
      renderCard(t.tour);
      expect(await screen.findByText(/No se pudo leer el precio de la finca/)).toBeInTheDocument();
      let ok: boolean | undefined;
      await act(async () => {
        ok = await t.run();
      });
      expect(ok).toBe(false);
    }, 20000);

    it("refuses a price that is too low and says why", async () => {
      const user = userEvent.setup();
      serveState({});
      const t = fakeTour();
      renderCard(t.tour);
      await waitFor(() => expect(priceField()).toHaveValue("1.000"));
      await user.clear(priceField());
      await user.type(priceField(), "50");
      let ok: boolean | undefined;
      await act(async () => {
        ok = await t.run();
      });
      expect(ok).toBe(false);
      expect(await screen.findByText(/es muy poco/)).toBeInTheDocument();
    }, 20000);

    it("keeps a price that is already right without saving", async () => {
      serveState({});
      const t = fakeTour();
      renderCard(t.tour);
      await waitFor(() => expect(priceField()).toHaveValue("1.000"));
      let ok: boolean | undefined;
      await act(async () => {
        ok = await t.run();
      });
      expect(ok).toBe(true);
      expect(t.note).toHaveBeenCalledWith({ priceCents: 100000 });
    }, 20000);

    it("saves a changed price", async () => {
      const user = userEvent.setup();
      serveState({});
      server.use(
        http.put("*/v1/prices/base/:monday", () =>
          HttpResponse.json({
            currentCents: 120000,
            confirmed: true,
            thisWeek: "2026-01-05",
            history: [{ validFrom: "2026-01-05", priceCents: 120000 }],
          }),
        ),
      );
      const t = fakeTour();
      renderCard(t.tour);
      await waitFor(() => expect(priceField()).toHaveValue("1.000"));
      await user.clear(priceField());
      await user.type(priceField(), "1200");
      let ok: boolean | undefined;
      await act(async () => {
        ok = await t.run();
      });
      expect(ok).toBe(true);
      expect(t.note).toHaveBeenCalledWith({ priceCents: 120000 });
      expect(await screen.findByText(/Listo: \$1\.200 por kilo/)).toBeInTheDocument();
    }, 20000);
  });
});
