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

describe("las liquidaciones de la finca", () => {
  it("las encuentra, con el periodo que de verdad cubren", async () => {
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
  it("cuenta las líneas con itemCount, no con un array que llega vacío", async () => {
    renderAt("/liquidaciones");
    const row = (await screen.findByText("Édinson Marín Ríos")).closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    // Empleado, Periodo, Registrada, Líneas, Bruto, Estado.
    expect(cells[3]).toHaveTextContent("1");
    expect(cells[3]).not.toHaveTextContent("0");
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
    // 400 ms y no 50: con la suite entera corriendo, los 50 se agotaban
    // mientras `findByText` hacía su primer sondeo y la carga se perdía entre
    // una aserción y la siguiente. Un fallo intermitente en una prueba sobre
    // «no inventes una cifra mientras cargas» es peor que inútil: enseña a
    // volver a lanzarla.
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
 * ── «NO HAY» NO ES LO MISMO QUE «NO PUDE» ────────────────────────────────
 *
 * Sin `GET /v1/settlements`, esta lista se compone leyendo el libro de cada
 * empleado, y `api.listSettlements` se tragaba cada fallo con un
 * `.catch(() => [])`. Con los libros caídos, la pantalla llegaba a AFIRMAR, en
 * presente y sobre la finca, que «todavía no se ha liquidado nada en esta
 * finca» — y ofrecía imprimir la planilla, en blanco, con su columna de
 * firmas. Es la frase que convierte una caída de red en una declaración sobre
 * el negocio de otra persona.
 */
describe("cuando parte de la consulta falla", () => {
  /** Fuerza el abanico (405) y tumba los libros. */
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

  it("no afirma que la finca no ha liquidado nada", async () => {
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

  it("y no deja imprimir una planilla en blanco", async () => {
    fanOutWithBrokenLedgers();
    renderAt("/liquidaciones");
    await screen.findByText(/Esta lista está incompleta/);
    // Un papel que se firma no sale de una lectura que se sabe rota.
    expect(screen.getByRole("button", { name: /Planilla/ })).toBeDisabled();
  }, 20000);
});

/**
 * ── EL FILTRO, EN LA PANTALLA Y EN EL PAPEL ──────────────────────────────
 *
 * Everything on this screen is a sum over the filtered rows, under labels that
 * read as facts about the farm. The document is worse: it comes out with the
 * farm's name, today's date and a signature column, and no mention that it is
 * a search result. Both halves are asserted here, because fixing only the
 * screen would leave the sheet that actually gets signed still lying.
 */
describe("cuando hay un filtro puesto", () => {
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

  it("lo dice en pantalla y ofrece quitarlo", async () => {
    const user = userEvent.setup();
    renderAt("/liquidaciones");
    await screen.findByText("Édinson Marín Ríos");

    await user.type(screen.getByLabelText("Buscar por empleado"), "Édinson");

    // The card cannot go on calling itself the farm's figure.
    expect(await screen.findByText("Bruto liquidado (vigentes, filtrado)")).toBeInTheDocument();
    expect(screen.getByText(/Está viendo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar el filtro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Planilla \(parcial\)/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar el filtro" }));
    expect(await screen.findByText("Bruto liquidado (vigentes)")).toBeInTheDocument();
    expect(screen.queryByText(/Está viendo/)).not.toBeInTheDocument();
  }, 20000);

  it("y la planilla impresa lo dice también", async () => {
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
