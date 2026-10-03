// SPDX-License-Identifier: MIT
/**
 * The week price page's last edges: a week with no price at all, the
 * farm and the week's labores failing on their own, how one labor and one
 * frozen labor are spelled, and the base price card refreshing the page.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WeekPricePage } from "./WeekPricePage";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner } from "../../test/renderWithAuth";
import { mondayOf, todayInFarm } from "../../lib/dates";

const KG = "0192f3a0-000d-7000-8000-000000000001";

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
const monday = () => mondayOf(todayInFarm("America/Bogota"));

function labor(id: string, settled: boolean) {
  const when = `${monday()}T00:00:00Z`;
  return {
    id,
    workerId: "0192f3a0-0006-7000-8000-000000000001",
    activityId: "0192f3a0-0007-7000-8000-000000000001",
    payScheme: "unidad_trabajo",
    rateSource: "weekly_price",
    dateFrom: when,
    dateTo: when,
    quantity: "20",
    unitId: KG,
    rateCents: settled ? 80_000 : null,
    amountCents: settled ? 1_600_000 : null,
    estimatedAmountCents: 1_600_000,
    amountIsEstimate: !settled,
    note: null,
    createdBy: null,
    createdAt: when,
    deletedAt: null,
    plotIds: [],
    plotCropIds: [],
    settled,
  };
}

function serveLabores(items: unknown[]) {
  server.use(http.get("*/v1/work-records", () => HttpResponse.json({ items })));
}

const boom = () =>
  HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 });

beforeEach(() => {
  signInOwner();
  invalidateRefs();
});

describe("WeekPricePage edges", () => {
  it('shows "—" for a week that has no price', async () => {
    server.use(
      http.get("*/v1/prices/weeks/:monday", ({ params }) =>
        HttpResponse.json({ weekStart: params.monday, priceCents: null }),
      ),
    );
    renderPrices();
    await ready();
    // The big figure is a dash, not $0.
    expect(await screen.findByText("—", { selector: "h1" })).toBeInTheDocument();
  }, 20000);

  it("still lets the price be set when the farm and the labores cannot be read", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/farm", boom), http.get("*/v1/work-records", boom));
    renderPrices();
    await ready();
    expect(
      await screen.findByText(/No se pudieron consultar las labores de esta semana/),
    ).toBeInTheDocument();
    await user.type(priceInput(), "900");
    await user.click(review());
    const dialog = await screen.findByRole("dialog");
    // Nothing is said about how much moves: it is not known.
    expect(within(dialog).queryByText(/sin liquidar, hoy/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/No hay recolección sin liquidar/)).not.toBeInTheDocument();
  }, 20000);

  it("spells one movable labor and one frozen labor in the singular", async () => {
    const user = userEvent.setup();
    serveLabores([labor("w1", false), labor("w2", true)]);
    renderPrices();
    await ready();
    expect(
      await screen.findByText(/1 labor de esa semana ya está liquidada y no se toca/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" && /^1 labor de recolección sin liquidar · 20 kg/.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
    await user.type(priceInput(), "900");
    await user.click(review());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/1\s+labor sin liquidar/)).toBeInTheDocument();
  }, 20000);

  it("spells several frozen labores in the plural", async () => {
    serveLabores([labor("w1", true), labor("w2", true)]);
    renderPrices();
    await ready();
    expect(
      await screen.findByText(/2 labores de esa semana ya están liquidadas y no se tocan/),
    ).toBeInTheDocument();
  }, 20000);

  it("reloads the week after the base price is saved", async () => {
    const user = userEvent.setup();
    let weekReads = 0;
    server.use(
      http.get("*/v1/prices/weeks/:monday", ({ params }) => {
        weekReads++;
        return HttpResponse.json({ weekStart: params.monday, priceCents: 80_000 });
      }),
    );
    renderPrices();
    await ready();
    const field = await screen.findByLabelText("Precio por kilo en pesos");
    await waitFor(() => expect(field).not.toBeDisabled());
    const before = await waitFor(() => {
      expect(weekReads).toBeGreaterThan(0);
      return weekReads;
    });
    await user.clear(field);
    await user.type(field, "1500");
    await user.click(screen.getByRole("button", { name: "Guardar precio" }));
    await user.click(await screen.findByRole("button", { name: "Sí, guardar el precio" }));
    expect(await screen.findByText(/Listo: \$1\.500 por kilo/)).toBeInTheDocument();
    await waitFor(() => expect(weekReads).toBeGreaterThan(before));
  }, 30000);
});
