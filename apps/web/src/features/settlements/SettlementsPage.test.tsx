/**
 * The settlements module.
 *
 * The interesting part is not the table — it is that the list exists at all
 * without a `GET /v1/settlements` behind it. `api.listSettlements` reads every
 * worker's ledger, collects the `settlementId` off each `devengo`, and fetches
 * those settlements. So the first thing worth asserting is that the
 * composition FINDS things: a settlement made through the app has to appear
 * here, or the composition is a decoration.
 *
 * After that, the two rules the domain actually cares about: a void settlement
 * is listed and not hidden, and its lines keep the price they froze.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { SettlementsPage } from "./SettlementsPage";
import { SettlementDetailPage } from "./SettlementDetailPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { api } from "../../api/endpoints";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import * as db from "../../mocks/db";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
/** The settlement the farm was seeded with, Édinson's. */
const SEEDED = "0192f3a0-000b-7000-8000-000000000001";

function renderAt(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/liquidaciones" element={<SettlementsPage />} />
            <Route path="/liquidaciones/:id" element={<SettlementDetailPage />} />
          </Routes>
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

describe("las liquidaciones de la finca", () => {
  it("las encuentra sin que exista GET /v1/settlements", async () => {
    renderAt("/liquidaciones");
    // Seeded: Édinson's, $150.000.
    expect(await screen.findByText("Édinson Marín Ríos")).toBeInTheDocument();
    // Twice on purpose: once as the row's gross, once as the farm's total,
    // because it is the only live settlement.
    expect(screen.getAllByText("$150.000")).toHaveLength(2);
    // And the period is the one actually covered, not the 1970 the client asks
    // over when it means "everything outstanding".
    expect(screen.getByText(/17–23 ago/)).toBeInTheDocument();
  }, 20000);

  it("encuentra también una liquidación hecha hace un momento", async () => {
    const approved = await api.previewSettlement(MARIA);
    await api.settle(
      MARIA,
      approved.lines.map((l) => l.id),
      { expectedGrossCents: approved.grossCents },
    );

    renderAt("/liquidaciones");
    expect(await screen.findByText("María Restrepo Ospina")).toBeInTheDocument();
    expect(screen.getByText("$153.600")).toBeInTheDocument();
  }, 20000);

  it("no inventa un total mientras carga", async () => {
    // The fan-out is held open so the loading state is observable rather than
    // raced for. On a real farm it is several round trips and this state is
    // what somebody actually looks at for a second.
    server.use(
      http.get("*/v1/workers/:id/ledger", async () => {
        await delay(50);
        return HttpResponse.json({ items: [] });
      }),
    );
    renderAt("/liquidaciones");

    // A "$0" here is a claim that this farm has settled nothing, and somebody
    // will read it. There is no figure at all until there is one.
    expect(await screen.findByText("Cargando…")).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(
      screen.getByText("Reuniendo las liquidaciones de cada empleado…"),
    ).toBeInTheDocument();
  }, 20000);
});

describe("una liquidación por dentro", () => {
  it("muestra las líneas al precio al que se congelaron", async () => {
    renderAt(`/liquidaciones/${SEEDED}`);
    await screen.findByText(/Liquidación de Édinson/);
    // $50.000 a contract, x3 = $150.000. The rate is the one the settlement
    // froze, not the one the activity carries today.
    expect(screen.getByText("$50.000")).toBeInTheDocument();
    expect(screen.getByText("Bruto liquidado")).toBeInTheDocument();
  }, 20000);

  /**
   * `docs/sincronizacion.md`: "Anular la liquidación no es un botón de esa
   * pantalla: es una decisión del administrador". So it is not next to
   * "Imprimir" — it is under its own heading, and the confirmation says the
   * consequence out loud.
   */
  it("anular está aparte, y la confirmación dice que es definitivo", async () => {
    const user = userEvent.setup();
    renderAt(`/liquidaciones/${SEEDED}`);
    await screen.findByText("Anular esta liquidación");

    await user.click(screen.getByRole("button", { name: "Anular la liquidación" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Anular es definitivo: una liquidación anulada nunca vuelve/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Sí, anular" }));

    // It stays on screen, marked — it is not hidden and it is not emptied.
    expect(await screen.findByText(/Liquidación anulada/)).toBeInTheDocument();
    expect(screen.getAllByText("$150.000").length).toBeGreaterThan(0);
    // And there is no way back: the void control is gone, not disabled.
    expect(screen.queryByText("Anular esta liquidación")).not.toBeInTheDocument();
  }, 20000);

  it("la anulada sigue en la lista, no desaparece", async () => {
    await api.voidSettlement(SEEDED);
    renderAt("/liquidaciones");
    expect(await screen.findByText("Édinson Marín Ríos")).toBeInTheDocument();
    expect(screen.getByText(/^Anulada \d/)).toBeInTheDocument();
    // …and it stops counting towards the farm's total, because its devengo was
    // cancelled by a reverso. THIS zero is computed and true — the farm really
    // has nothing live — which is the difference between a figure and a
    // placeholder.
    expect(screen.getByText("Bruto liquidado (vigentes)")).toBeInTheDocument();
    expect(screen.getByText("$0")).toBeInTheDocument();
  }, 20000);
});
