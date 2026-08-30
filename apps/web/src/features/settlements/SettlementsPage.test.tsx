/**
 * The settlements module.
 *
 * The interesting part is not the table — it is that the list exists at all
 * without a `GET /v1/settlements` behind it. `api.listSettlements` reads every
 * worker's ledger, collects the `settlementId` off each earning line, and fetches
 * those settlements. So the first thing worth asserting is that the
 * composition FINDS things: a settlement made through the app has to appear
 * here, or the composition is a decoration.
 *
 * After that, the two rules the domain actually cares about: a void settlement
 * is listed and not hidden, and its lines keep the price they froze.
 */
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
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

describe("the farm's settlements", () => {
  it("finds them, with the period they actually cover", async () => {
    renderAt("/liquidaciones");
    // Seeded: Édinson's, $150.000.
    expect(await screen.findByText("Édinson Marín Ríos")).toBeInTheDocument();
    // Twice on purpose: once as the row's gross, once as the farm's total,
    // because it is the only live settlement.
    expect(screen.getAllByText("$150.000")).toHaveLength(2);
    /**
     * BOTH ENDS OF THE PERIOD. This settlement covers 17–22 August. The column
     * used to call `formatWeekRange(periodStart)`, which prints the seven days
     * after a Monday and therefore said "17–23 ago" — a day the settlement
     * does not cover. On the running farm the same call labelled settlements
     * running to August 2027 as "24–30 ago", while the printed sheet had it
     * right: screen and paper contradicting each other about one document.
     */
    expect(screen.getByText("17–22 ago")).toBeInTheDocument();
    expect(screen.queryByText(/17–23 ago/)).not.toBeInTheDocument();
  }, 20000);

  /**
   * "LÍNEAS" COUNTED AN ARRAY THE SERVER SENDS EMPTY ON PURPOSE.
   *
   * `GET /v1/settlements` documents it in as many words — "`items` is always
   * an empty array, fetch /v1/settlements/{id} for the lines" — and sends
   * `itemCount` instead. The console counted `items.length`, so every
   * settlement in the farm read LÍNEAS: 0, including ones with five.
   */
  it("counts the lines with itemCount, not with an array that arrives empty", async () => {
    renderAt("/liquidaciones");
    const row = (await screen.findByText("Édinson Marín Ríos")).closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    // Empleado, Periodo, Registrada, Líneas, Bruto, Estado — the column order.
    expect(cells[3]).toHaveTextContent("1");
    expect(cells[3]).not.toHaveTextContent("0");
  }, 20000);

  it("also finds a settlement made a moment ago", async () => {
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

  it("does not invent a total while loading", async () => {
    // The fan-out is held open so the loading state is observable rather than
    // raced for. On a real farm it is several round trips and this state is
    // what somebody actually looks at for a second.
    // 400 ms and not 50: with the whole suite running, the 50 ran out while
    // `findByText` was taking its first poll, and the loading state was lost
    // between one assertion and the next. A flaky failure in a test about
    // "don't invent a figure while loading" is worse than useless: it teaches
    // people to re-run it.
    server.use(
      http.get("*/v1/settlements", async () => {
        await delay(400);
        return HttpResponse.json({ items: [], total: 0 });
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

/**
 * ── "THERE ARE NONE" IS NOT "I COULDN'T ASK" ─────────────────────────────
 *
 * Without `GET /v1/settlements`, this list is assembled by reading every
 * employee's ledger, and `api.listSettlements` swallowed each failure with a
 * `.catch(() => [])`. With the ledgers down, the screen went as far as
 * ASSERTING, in the present tense and about the farm, that "todavía no se ha
 * liquidado nada en esta finca" — and offered to print the payroll sheet,
 * blank, signature column and all. That is the sentence that turns a network
 * outage into a statement about somebody else's business.
 */
describe("when part of the query fails", () => {
  /** Forces the fan-out (405) and knocks the ledgers over. */
  function fanOutWithBrokenLedgers() {
    server.use(
      http.get("*/v1/settlements", () =>
        HttpResponse.json({ error: { code: "NOT_FOUND", message: "no" } }, { status: 405 }),
      ),
      http.get("*/v1/workers/:id/ledger", () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
  }

  it("does not assert that the farm has settled nothing", async () => {
    fanOutWithBrokenLedgers();
    renderAt("/liquidaciones");

    expect(await screen.findByText(/Esta lista está incompleta/)).toBeInTheDocument();
    expect(
      screen.queryByText("Todavía no se ha liquidado nada en esta finca."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/No quiere decir que no las haya: parte de la consulta falló/),
    ).toBeInTheDocument();
  }, 20000);

  it("and does not let a blank payroll sheet be printed", async () => {
    fanOutWithBrokenLedgers();
    renderAt("/liquidaciones");
    await screen.findByText(/Esta lista está incompleta/);
    // Paper that gets signed does not come out of a read we know is broken.
    expect(screen.getByRole("button", { name: /Planilla/ })).toBeDisabled();
  }, 20000);
});

/**
 * ── THE FILTER, ON THE SCREEN AND ON THE PAPER ───────────────────────────
 *
 * Everything on this screen is a sum over the filtered rows, under labels that
 * read as facts about the farm. The document is worse: it comes out with the
 * farm's name, today's date and a signature column, and no mention that it is
 * a search result. Both halves are asserted here, because fixing only the
 * screen would leave the sheet that actually gets signed still lying.
 */
describe("when a filter is in place", () => {
  /** Intercepts what `printDocument` was handed, without opening a frame. */
  function capturePrintedHtml(): { get: () => string } {
    let html = "";
    const frames: HTMLIFrameElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === "iframe") {
        frames.push(el as HTMLIFrameElement);
        Object.defineProperty(el, "srcdoc", {
          set(v: string) {
            html = v;
          },
          get: () => html,
          configurable: true,
        });
      }
      return el;
    }) as typeof document.createElement);
    return { get: () => html };
  }

  afterEach(() => vi.restoreAllMocks());

  it("says so on screen and offers to clear it", async () => {
    const user = userEvent.setup();
    renderAt("/liquidaciones");
    await screen.findByText("Édinson Marín Ríos");

    await user.type(screen.getByLabelText("Buscar por empleado"), "Édinson");

    // The card cannot go on calling itself the farm's figure.
    expect(await screen.findByText("Bruto liquidado (sin las anuladas, filtrado)")).toBeInTheDocument();
    expect(screen.getByText(/Está viendo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar el filtro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Planilla \(parcial\)/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar el filtro" }));
    expect(await screen.findByText("Bruto liquidado (sin las anuladas)")).toBeInTheDocument();
    expect(screen.queryByText(/Está viendo/)).not.toBeInTheDocument();
  }, 20000);

  it("and the printed payroll sheet says so too", async () => {
    const user = userEvent.setup();
    renderAt("/liquidaciones");
    await screen.findByText("Édinson Marín Ríos");
    await user.type(screen.getByLabelText("Buscar por empleado"), "Édinson");

    const printed = capturePrintedHtml();
    await user.click(screen.getByRole("button", { name: /Planilla/ }));

    const html = printed.get();
    expect(html).toContain("PLANILLA PARCIAL");
    expect(html).toContain("empleado contiene «Édinson»");
    expect(html).toContain("Bruto liquidado (filtrado)");
    // Next to the signature, which is the part of the page somebody looks at
    // while signing it.
    expect(html).toContain("PARCIAL ·");
  }, 20000);
});

describe("a settlement from the inside", () => {
  it("shows the lines at the price they were frozen at", async () => {
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
  it("voiding sits apart, and the confirmation says it is final", async () => {
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

  it("the voided one stays in the list, it does not disappear", async () => {
    await api.voidSettlement(SEEDED);
    renderAt("/liquidaciones");
    expect(await screen.findByText("Édinson Marín Ríos")).toBeInTheDocument();
    expect(screen.getByText(/^Anulada \d/)).toBeInTheDocument();
    // …and it stops counting towards the farm's total, because its devengo was
    // cancelled by a reverso. THIS zero is computed and true — the farm really
    // has nothing live — which is the difference between a figure and a
    // placeholder.
    expect(screen.getByText("Bruto liquidado (sin las anuladas)")).toBeInTheDocument();
    expect(screen.getByText("$0")).toBeInTheDocument();
  }, 20000);
});
