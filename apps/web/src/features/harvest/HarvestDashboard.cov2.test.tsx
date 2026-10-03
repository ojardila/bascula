// SPDX-License-Identifier: MIT
/**
 * «Modo cosecha» dashboard: the readings the page tests do not reach — a
 * refused or failed load, a falling or flat week, unknown kilos on a lote or a
 * person, a long crew list, and a week where nobody has picked yet.
 */
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { addDays, mondayOf, parseDay } from "../../lib/dates";
import type {
  WireHarvestDashboard,
  WireHarvestDashboardPerson,
  WireReportTotals,
} from "../../api/wire";
import { HarvestDashboard } from "./HarvestDashboard";

const today = new Date().toISOString().slice(0, 10);
const thisMonday = mondayOf(today);
const lastMonday = addDays(parseDay(thisMonday), -7).toISOString().slice(0, 10);

const totals = (over: Partial<WireReportTotals> = {}): WireReportTotals => ({
  records: 0,
  kg: null,
  recordsNotInKg: 0,
  valueCents: null,
  recordsWithoutValue: 0,
  valueIsEstimate: false,
  recordsSpanningWeeks: 0,
  ...over,
});
const kg = (n: number, records = 1) => totals({ records, kg: n, valueCents: n * 1000 });

const person = (
  id: string,
  name: string,
  over: Partial<WireHarvestDashboardPerson> = {},
): WireHarvestDashboardPerson => ({
  ...kg(50),
  employeeId: id,
  name,
  tag: null,
  kind: "persona",
  members: 1,
  kgEach: 50,
  daysWorked: 1,
  kgPerDay: 50,
  pickedToday: true,
  belowAverage: false,
  ...over,
});

function dashboard(over: Partial<WireHarvestDashboard> = {}): WireHarvestDashboard {
  return {
    scope: "harvest",
    today,
    thisWeek: thisMonday,
    lastWeek: lastMonday,
    belowAverageRatio: 0.7,
    summary: {
      thisWeek: kg(100, 2),
      lastWeekToDate: kg(300, 4),
      lastWeek: kg(400, 5),
      today: kg(20),
      pickersToday: 1,
      pickersThisWeek: 2,
      personDays: 2,
      kgPerPersonDay: null,
    },
    days: Array.from({ length: 7 }, (_, i) => ({
      ...totals(),
      day: addDays(parseDay(thisMonday), i).toISOString().slice(0, 10),
      pickers: 0,
      future: false,
    })),
    plots: [],
    unattributed: kg(40),
    people: [],
    notToday: [],
    ...over,
  };
}

function serve(d: WireHarvestDashboard) {
  server.use(http.get("*/v1/reports/harvest-dashboard", () => HttpResponse.json(d)));
}

describe("HarvestDashboard", () => {
  it("leaves the module when the server refuses the report", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/harvest-dashboard", () =>
        HttpResponse.json({ error: { code: "forbidden", message: "forbidden" } }, { status: 403 }),
      ),
    );
    renderWithAuth(<HarvestDashboard canSeeMoney />);
    expect(await screen.findByText("No tiene permiso para ver la cosecha")).toBeInTheDocument();
  });

  it("says the figures are not zero when the report fails", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/harvest-dashboard", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderWithAuth(<HarvestDashboard canSeeMoney />);
    expect(await screen.findByText(/No se pudo consultar la semana de cosecha/)).toBeInTheDocument();
  });

  it("words a falling week, unknown kilos and lotes without kilos, without money", async () => {
    signInOwner();
    serve(
      dashboard({
        plots: [
          {
            ...totals({ records: 2, recordsNotInKg: 2 }),
            plotId: "p1",
            name: "La Loma",
            lastWeekToDateKg: null,
            lastWeekKg: null,
            share: null,
            pickers: 1,
          },
        ],
        people: [
          person("e1", "Ana Restrepo", { ...totals({ records: 1, recordsNotInKg: 1 }), kgEach: null, kgPerDay: null }),
          person("t1", "Yorman y Sergio", {
            kind: "equipo",
            members: 2,
            ...totals({ records: 1, recordsNotInKg: 1 }),
            kgEach: null,
            kgPerDay: 20,
          }),
        ],
      }),
    );
    renderWithAuth(<HarvestDashboard canSeeMoney={false} />);
    const dash = await screen.findByTestId("harvest-dashboard");
    const d = within(dash);
    expect(d.getByText(/menos que la semana pasada/)).toBeInTheDocument();
    expect(d.queryByText("Pago de la semana")).not.toBeInTheDocument();
    expect(d.getByText("Promedio por persona").parentElement).toHaveTextContent("—");
    expect(
      d.getByText(/Quién más kilos lleva esta semana\. Toque una persona/),
    ).toBeInTheDocument();
    expect(d.getByRole("link", { name: "La Loma: sin kilos esta semana" })).toBeInTheDocument();
    expect(d.getByText("1 persona · sin kilos")).toBeInTheDocument();
    expect(d.getByRole("link", { name: "1. Ana Restrepo: sin kilos" })).toBeInTheDocument();
    expect(d.getByRole("link", { name: "2. Yorman y Sergio: sin kilos" })).toBeInTheDocument();
    expect(d.getByText("Equipo de 2")).toBeInTheDocument();
    expect(d.getByText(/1 día · 20 kg al día c\/u/)).toBeInTheDocument();
    expect(d.getByText(/40 kg de esta semana no tienen un lote/)).toBeInTheDocument();
  });

  it("keeps a flat week neutral, says nobody picked yet and that no lote is set", async () => {
    signInOwner();
    serve(
      dashboard({
        summary: {
          ...dashboard().summary,
          thisWeek: kg(300, 4),
          lastWeekToDate: kg(300, 4),
          kgPerPersonDay: 30,
        },
        unattributed: totals(),
      }),
    );
    renderWithAuth(<HarvestDashboard canSeeMoney />);
    const dash = await screen.findByTestId("harvest-dashboard");
    const d = within(dash);
    expect(d.getByText(/Lo mismo que la semana pasada/)).toBeInTheDocument();
    expect(d.getByText(/Ninguna recolección de estas dos semanas tiene un lote asignado/)).toBeInTheDocument();
    expect(d.getByText("Nadie ha recogido esta semana todavía.")).toBeInTheDocument();
    expect(d.getByText(/Promedio de la finca: 30 kg por persona al día/)).toBeInTheDocument();
    expect(d.queryByText(/no tienen un lote/)).not.toBeInTheDocument();
  });

  it("lists the first ten people and opens and closes the rest", async () => {
    signInOwner();
    const people = Array.from({ length: 11 }, (_, i) =>
      person(`e${i + 1}`, `Persona ${String(i + 1).padStart(2, "0")}`),
    );
    serve(dashboard({ people }));
    const user = userEvent.setup();
    renderWithAuth(<HarvestDashboard canSeeMoney />);
    const more = await screen.findByRole("button", { name: "Ver las 11 personas" });
    expect(screen.queryByRole("link", { name: /^11\. Persona 11/ })).not.toBeInTheDocument();
    await user.click(more);
    expect(screen.getByRole("link", { name: /^11\. Persona 11/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver menos" }));
    expect(screen.queryByRole("link", { name: /^11\. Persona 11/ })).not.toBeInTheDocument();
  });
});
