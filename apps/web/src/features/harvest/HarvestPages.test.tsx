/**
 * The five harvest screens, rendered.
 *
 * `totals.test.ts` pins the readers and `e2e/harvest.test.ts` pins the wire.
 * What neither can catch is a screen that reads the right thing and then
 * PRINTS the wrong one — and the two promises this module makes are both
 * promises about printing:
 *
 *   1. a figure the server declined to establish shows as a dash, never `$0`;
 *   2. a provisional figure is visibly provisional.
 *
 * So the first test plants a week the server could not price and then asserts,
 * on the rendered DOM, that "$0" does not occur anywhere. That is a blunt
 * assertion and it is meant to be: `$0` against a harvest record is the exact
 * bug that shipped once already, and the reason it shipped is that every unit
 * test around it was green.
 *
 * The rest check what a person would notice in a demo and a test would not:
 * that the week grid cross-foots on screen, that the unattributed column is
 * shown and explained rather than hidden, that the yield screen leads with
 * what the number does NOT mean, and that the review screen speaks Spanish
 * rather than rule names.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { users } from "../../mocks/db";
import { addDays, mondayOf, parseDay } from "../../lib/dates";
import type {
  WireHarvestCurve, WireReportAnomaliesResult, WireReportGrid, WireReportPerformanceResult,
  WireReportTotals, WireReportWeekDetail, WireReportWeeksResult,
} from "../../api/wire";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";

function renderApp(path: string) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function signIn(id = OWNER) {
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error(`no seeded user ${id}`);
  setTokens({ accessToken: `mock-access.${id}.test`, refreshToken: `mock-refresh.${id}` });
}

const thisMonday = mondayOf(new Date().toISOString().slice(0, 10));
const weekOf = (back: number) =>
  addDays(parseDay(thisMonday), -7 * back).toISOString().slice(0, 10);

/** `ReportTotals`, defaulting to "nothing could be established". */
function totals(over: Partial<WireReportTotals> = {}): WireReportTotals {
  return {
    records: 0,
    kg: null,
    recordsNotInKg: 0,
    valueCents: null,
    recordsWithoutValue: 0,
    valueIsEstimate: false,
    ...over,
  };
}

/** Priced, in kilos, still an estimate — the ordinary case. */
const priced = (kg: number, records = 1): WireReportTotals =>
  totals({ records, kg, valueCents: Math.round(kg * 80_000), valueIsEstimate: true });

function serveWeeks(items: WireReportWeeksResult["items"]) {
  server.use(
    http.get("*/v1/reports/weeks", () => HttpResponse.json({ scope: "harvest", items })),
  );
}

function serveCurve(over: Partial<WireHarvestCurve> = {}) {
  server.use(
    http.get("*/v1/reports/harvest-curve", () =>
      HttpResponse.json({
        scope: "harvest",
        plotCropId: null,
        currentWeek: thisMonday,
        weeks: [],
        shape: { peak: null, fallingWeeks: 0, windingDown: false, reason: "no_finished_weeks" },
        weeksWithoutKilos: 0,
        ...over,
      } satisfies WireHarvestCurve),
    ),
  );
}

function serveWeekDetail(detail: WireReportWeekDetail) {
  server.use(http.get("*/v1/reports/weeks/:monday", () => HttpResponse.json(detail)));
}

function servePerformance(over: Partial<WireReportPerformanceResult> = {}) {
  server.use(
    http.get("*/v1/reports/performance", () =>
      HttpResponse.json({
        scope: "harvest",
        days: 182,
        since: weekOf(26),
        minComparableDays: 3,
        items: [],
        ...over,
      } satisfies WireReportPerformanceResult),
    ),
  );
}

function serveAnomalies(items: WireReportAnomaliesResult["items"]) {
  server.use(
    http.get("*/v1/reports/anomalies", () =>
      HttpResponse.json({
        scope: "harvest",
        days: 182,
        maxKg: 120,
        limit: 200,
        since: weekOf(26),
        items,
      } satisfies WireReportAnomaliesResult),
    ),
  );
}

const week = (weekStart: string, over: Partial<WireReportWeeksResult["items"][number]> = {}) => ({
  weekStart,
  ...priced(100, 4),
  pickers: 3,
  days: 2,
  priceCents: 80_000,
  finished: true,
  ...over,
});

beforeEach(() => {
  setTokens(null);
  invalidateRefs();
  localStorage.clear();
});

/* ------------------------------------------------------------------ */

describe("a figure the server could not establish never renders as a zero", () => {
  it("shows a dash with its reason, and $0 is nowhere on the screen", async () => {
    signIn();
    // A week with weighings the server could price for none of them. The old
    // behaviour printed "$0" against exactly this, on a screen a farm settles
    // from.
    serveWeeks([
      week(weekOf(2), totals({ records: 3, kg: 90, recordsWithoutValue: 3 })),
      week(weekOf(1), { ...totals({ records: 3, kg: 90, recordsWithoutValue: 3 }) }),
    ]);
    serveCurve();

    const { container } = renderApp("/cosecha");
    await screen.findByRole("heading", { name: "Cosecha" });
    await screen.findByText("Valor de la recolección");

    await waitFor(() => {
      expect(container.textContent).not.toMatch(/\$0(?!\d)/);
    });
    const dashes = await screen.findAllByLabelText(/No se pudo calcular el valor/);
    expect(dashes.length).toBeGreaterThan(0);
    // And it says the missing figure is NOT zero, in as many words.
    expect(dashes[0].getAttribute("aria-label")).toMatch(/No es cero/);
  }, 20000);

  it("says so when kilos could not be established, naming the cause", async () => {
    signIn();
    // Weighings in a unit with no kgFactor — "canasta". Multiplying by a
    // factor that is not there is how a report invents harvest.
    serveWeeks([week(weekOf(1), totals({ records: 4, recordsNotInKg: 4 }))]);
    serveCurve();

    renderApp("/cosecha");
    await screen.findByRole("heading", { name: "Cosecha" });
    const dashes = await screen.findAllByLabelText(/no convierte a kilos/);
    expect(dashes.length).toBeGreaterThan(0);
  }, 20000);

  it("marks a value that still rides on the week's price as an estimate", async () => {
    signIn();
    serveWeeks([week(weekOf(1)), week(weekOf(2))]);
    serveCurve();
    renderApp("/cosecha");
    await screen.findByRole("heading", { name: "Cosecha" });
    expect((await screen.findAllByText(/estimado/i)).length).toBeGreaterThan(0);
  }, 20000);

  it("presents a partial total as a floor, not as the total", async () => {
    signIn();
    serveWeeks([
      week(weekOf(1), {
        ...totals({ records: 4, kg: 90, valueCents: 5_000_000, recordsWithoutValue: 1 }),
      }),
    ]);
    serveCurve();
    renderApp("/cosecha");
    await screen.findByRole("heading", { name: "Cosecha" });
    expect((await screen.findAllByText(/al menos · faltan 1/)).length).toBeGreaterThan(0);
  }, 20000);
});

/* ------------------------------------------------------------------ */

describe("the season screen answers the question it exists for", () => {
  it("calls a season that has passed its peak and is falling", async () => {
    signIn();
    serveWeeks([week(weekOf(1)), week(weekOf(2)), week(weekOf(3))]);
    serveCurve({
      weeks: [
        { weekStart: weekOf(1), kg: 150 },
        { weekStart: weekOf(2), kg: 260 },
        { weekStart: weekOf(3), kg: 400 },
      ],
      shape: { peak: { weekStart: weekOf(3), kg: 400 }, fallingWeeks: 2, windingDown: true },
    });

    renderApp("/cosecha");
    expect(await screen.findByText(/La cosecha va de salida/)).toBeInTheDocument();
    expect(screen.getByText(/pasó su pico/)).toBeInTheDocument();
    expect(screen.getByText(/mover gente a otro lote/)).toBeInTheDocument();
  }, 20000);

  it("refuses to read a trend when no week has finished, and says so", async () => {
    signIn();
    serveWeeks([week(thisMonday, { finished: false })]);
    serveCurve({ weeks: [{ weekStart: thisMonday, kg: 40 }] });

    renderApp("/cosecha");
    expect(
      await screen.findByText(/Todavía no hay semanas terminadas suficientes/),
    ).toBeInTheDocument();
  }, 20000);

  it("says which weeks were left out of the reading, and why that is not a fall", async () => {
    signIn();
    serveWeeks([week(weekOf(1)), week(weekOf(2))]);
    serveCurve({
      weeks: [{ weekStart: weekOf(1), kg: 100 }],
      shape: { peak: { weekStart: weekOf(1), kg: 100 }, fallingWeeks: 0, windingDown: false },
      weeksWithoutKilos: 2,
    });

    renderApp("/cosecha");
    expect(await screen.findByText(/Tratarlas como cero habría fabricado una caída/)).toBeInTheDocument();
  }, 20000);

  it("tells a farm with no picking what makes a labor part of the harvest", async () => {
    signIn();
    serveWeeks([]);
    serveCurve();
    renderApp("/cosecha");
    expect(
      await screen.findByText(/pagada por unidad de trabajo al precio de la semana/),
    ).toBeInTheDocument();
  }, 20000);

  it("marks the running week so its total is not compared by eye", async () => {
    signIn();
    serveWeeks([week(thisMonday, { finished: false }), week(weekOf(1))]);
    serveCurve({
      weeks: [{ weekStart: weekOf(1), kg: 100 }],
      shape: { peak: { weekStart: weekOf(1), kg: 100 }, fallingWeeks: 0, windingDown: false },
    });
    renderApp("/cosecha");
    expect(await screen.findByText("en curso")).toBeInTheDocument();
  }, 20000);
});

/* ------------------------------------------------------------------ */

describe("the week detail cross-foots on screen", () => {
  const monday = weekOf(1);

  /** Two people, two days: 30 + 20 and 40, so the margins are 70, 20 and 90. */
  function grid(axis: "day" | "crop"): WireReportGrid {
    const c1 = axis === "day" ? `${monday}` : "crop-1";
    const c2 = axis === "day" ? addDays(parseDay(monday), 2).toISOString().slice(0, 10) : "crop-2";
    return {
      columns: [
        { key: c1, label: axis === "day" ? c1 : "Café — La Cuchilla", total: priced(70, 2) },
        { key: c2, label: axis === "day" ? c2 : "Café — El Guamo", total: priced(20, 1) },
      ],
      rows: [
        {
          workerId: "w1",
          name: "María Restrepo",
          cells: [
            { column: c1, ...priced(30) },
            { column: c2, ...priced(20) },
          ],
          total: priced(50, 2),
        },
        {
          workerId: "w2",
          name: "Jorge Salazar",
          cells: [{ column: c1, ...priced(40) }],
          total: priced(40, 1),
        },
      ],
      total: priced(90, 3),
    };
  }

  beforeEach(() => {
    signIn();
    serveWeekDetail({
      scope: "harvest",
      weekStart: monday,
      finished: true,
      byDay: grid("day"),
      byCrop: grid("crop"),
      total: priced(90, 3),
    });
  });

  it("shows both margins adding to the same grand total", async () => {
    renderApp(`/cosecha/semana/${monday}`);
    await screen.findByText("Quién recogió, y dónde");

    const table = screen.getAllByRole("table")[0];
    const footer = within(table).getAllByRole("row").at(-1)!;
    expect(within(footer).getByText("90")).toBeInTheDocument();
    expect(within(footer).getByText("70")).toBeInTheDocument();
    expect(within(footer).getByText("20")).toBeInTheDocument();
    expect(screen.queryByText(/no cuadran por filas y columnas/)).not.toBeInTheDocument();
  }, 20000);

  it("leaves a day somebody did not work blank, not zero", async () => {
    renderApp(`/cosecha/semana/${monday}`);
    await screen.findByText("Quién recogió, y dónde");

    const table = screen.getAllByRole("table")[0];
    const empty = within(table).getAllByLabelText(/no registró recolección ese día/);
    expect(empty.length).toBeGreaterThan(0);
    expect(within(table).queryByText(/^0$/)).not.toBeInTheDocument();
  }, 20000);

  it("switches the same week to worker x crop, keeping the grand total", async () => {
    const user = userEvent.setup();
    renderApp(`/cosecha/semana/${monday}`);
    await screen.findByText("Quién recogió, y dónde");

    await user.click(screen.getByRole("button", { name: "Por cultivo" }));
    expect(await screen.findByText(/Kilos por recolector y cultivo/)).toBeInTheDocument();
    const table = screen.getAllByRole("table")[0];
    const footer = within(table).getAllByRole("row").at(-1)!;
    expect(within(footer).getByText("90")).toBeInTheDocument();
  }, 20000);

  it("says a week nobody worked is an answer, not an error", async () => {
    const empty: WireReportGrid = { columns: [], rows: [], total: totals() };
    serveWeekDetail({
      scope: "harvest",
      weekStart: monday,
      finished: true,
      byDay: empty,
      byCrop: empty,
      total: totals(),
    });
    renderApp(`/cosecha/semana/${monday}`);
    expect(await screen.findByText(/Nadie recogió en la semana/)).toBeInTheDocument();
  }, 20000);
});

describe("the unattributed column is shown and explained, never hidden", () => {
  const monday = weekOf(1);

  it("keeps the column so the totals still cross-foot, and says what it is", async () => {
    signIn();
    const byCrop: WireReportGrid = {
      columns: [
        { key: "crop-1", label: "Café — La Cuchilla", total: priced(60, 2) },
        // Hiding this would make the remaining columns fail to add to 90,
        // which would read as OUR bug rather than a property of the data.
        { key: null, label: "Sin asignar", total: priced(30, 1) },
      ],
      rows: [
        {
          workerId: "w1",
          name: "María Restrepo",
          cells: [
            { column: "crop-1", ...priced(60, 2) },
            { column: null, ...priced(30) },
          ],
          total: priced(90, 3),
        },
      ],
      total: priced(90, 3),
      unattributed: { noCropLink: 1, sharedAcrossCrops: 0 },
    };
    serveWeekDetail({
      scope: "harvest",
      weekStart: monday,
      finished: true,
      byDay: {
        columns: [{ key: monday, label: monday, total: priced(90, 3) }],
        rows: [
          {
            workerId: "w1",
            name: "María Restrepo",
            cells: [{ column: monday, ...priced(90, 3) }],
            total: priced(90, 3),
          },
        ],
        total: priced(90, 3),
      },
      byCrop,
      total: priced(90, 3),
    });

    const user = userEvent.setup();
    renderApp(`/cosecha/semana/${monday}`);
    await screen.findByText("Quién recogió, y dónde");
    await user.click(screen.getByRole("button", { name: "Por cultivo" }));

    expect(await screen.findByText("Sin cultivo asignado.")).toBeInTheDocument();
    expect(screen.getByText(/no dice en qué cultivo se recogió/)).toBeInTheDocument();
    expect(screen.getByText(/los totales cuadren/)).toBeInTheDocument();
    // The column itself is in the table, carrying its kilos.
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getAllByText("Sin asignar").length).toBeGreaterThan(0);
  }, 20000);
});

/* ------------------------------------------------------------------ */

describe("the yield screen is built so the comparison stays fair", () => {
  const person = (name: string, index: number | null, over = {}) => ({
    workerId: `w-${name}`,
    name,
    ...priced(200, 8),
    days: 8,
    kgPerDay: 25,
    index,
    comparableDays: index === null ? 1 : 8,
    trend: null,
    ...over,
  });

  it("leads with what the number means and what it does not", async () => {
    signIn();
    servePerformance({ items: [person("Ana Pérez", 1.5)] });
    renderApp("/cosecha/rendimiento");

    expect(await screen.findByText(/Qué está comparando esta pantalla/)).toBeInTheDocument();
    expect(screen.getByText(/mismo lote.*mismo día/)).toBeInTheDocument();
    expect(screen.getByText(/No mide esfuerzo ni horas/)).toBeInTheDocument();
  }, 20000);

  it("shows the index with the context that makes it fair, and no ranking position", async () => {
    signIn();
    servePerformance({
      items: [person("Ana Pérez", 1.5), person("Beto Pérez", 1.0), person("Cira Pérez", 0.7)],
    });
    const { container } = renderApp("/cosecha/rendimiento");
    await screen.findByText(/Cómo se reparte el rendimiento/);

    expect(await screen.findByText("1,50")).toBeInTheDocument();
    expect(screen.getAllByText(/8 días comparables/).length).toBeGreaterThan(0);
    // The band is named, so colour never carries the meaning alone.
    expect(screen.getByText("por encima de sus compañeros")).toBeInTheDocument();
    expect(screen.getByText("en el promedio de su cuadrilla")).toBeInTheDocument();
    expect(screen.getByText("por debajo de sus compañeros")).toBeInTheDocument();
    // And nobody is given a position in a league table.
    expect(container.textContent).not.toMatch(/\b1\.º|\bPuesto\b|#1\b/);
  }, 20000);

  it("puts people it cannot compare in their own section, with the reason", async () => {
    signIn();
    servePerformance({
      items: [
        person("Ana Pérez", 1.5),
        person("Solo Pérez", null, { reason: "not_enough_comparable_days" }),
      ],
    });
    renderApp("/cosecha/rendimiento");

    expect(await screen.findByText("Sin base para comparar")).toBeInTheDocument();
    expect(screen.getByText(/no es que hayan rendido poco/)).toBeInTheDocument();
  }, 20000);

  it("explains a missing index caused by an unconvertible unit differently", async () => {
    signIn();
    servePerformance({
      items: [
        {
          ...person("Canasta Pérez", null, { reason: "no_records_in_kilos" }),
          kg: null,
          recordsNotInKg: 8,
          kgPerDay: null,
        },
      ],
    });
    renderApp("/cosecha/rendimiento");
    expect(
      await screen.findByText(/unidad que no convierte a kilos, así que no hay/),
    ).toBeInTheDocument();
  }, 20000);

  it("says nobody can be compared rather than showing an empty ranking", async () => {
    signIn();
    servePerformance({ items: [person("Solo Pérez", null)] });
    renderApp("/cosecha/rendimiento");
    expect(await screen.findByText(/Todavía no se puede comparar a nadie/)).toBeInTheDocument();
  }, 20000);
});

/* ------------------------------------------------------------------ */

describe("the review screen explains itself in sentences, not codes", () => {
  it("gives the reason with the numbers in it and never a rule name", async () => {
    signIn();
    serveAnomalies([
      {
        recordId: "r1",
        workerId: "w2",
        worker: "Beto Pérez",
        crop: "Café — La Cuchilla",
        quantity: 900,
        kg: 900,
        date: weekOf(1),
        rule: "impossible",
        reference: 120,
      },
    ]);

    const { container } = renderApp("/cosecha/revision");
    await screen.findByText(/Qué revisa esta pantalla/);

    expect(await screen.findByText(/merece una segunda mirada/)).toBeInTheDocument();
    expect(screen.getByText(/es más de lo que una persona alcanza a recoger/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/impossible|duplicate|outlier|digit|future/);
  }, 20000);

  it("never prints a reference of zero for a rule that has none", async () => {
    signIn();
    serveAnomalies([
      {
        recordId: "r2",
        workerId: "w1",
        worker: "María Restrepo",
        crop: null,
        quantity: 40,
        kg: 40,
        // `reference` is null for `future`: there is nothing to compare
        // against, and a 0 would read as "compared against nothing".
        date: "2099-01-01",
        rule: "future",
        reference: null,
      },
    ]);
    renderApp("/cosecha/revision");
    expect(await screen.findByText(/que todavía no ha llegado/)).toBeInTheDocument();
    expect(screen.getByText(/sin cultivo asignado/)).toBeInTheDocument();
  }, 20000);

  it("says a clean season is clean without claiming every weighing is exact", async () => {
    signIn();
    serveAnomalies([]);
    renderApp("/cosecha/revision");
    expect(await screen.findByText(/Eso no garantiza que todas sean exactas/)).toBeInTheDocument();
  }, 20000);
});

/* ------------------------------------------------------------------ */

describe("the module says what its figures cover, and who may see them", () => {
  it("says the figures are picking only, not the week's payroll", async () => {
    signIn();
    serveWeeks([week(weekOf(1))]);
    serveCurve();
    renderApp("/cosecha");
    expect(await screen.findByText("Solo recolección")).toBeInTheDocument();
  }, 20000);

  it("keeps the weigher out of it, because it reads the whole crew's figures", async () => {
    const weigher = users.find((u) => u.role === "weigher")!;
    signIn(weigher.id);
    renderApp("/cosecha");
    expect(await screen.findByText(/No tiene permiso para ver la cosecha/)).toBeInTheDocument();
  }, 20000);
});
