/**
 * The season screen's remaining paths: a member who cannot see money, a week
 * with no price, one week left out of the reading, a harvest winding down after
 * one bad week, the running week's per-day bars, and each chart taking you to
 * the week it was pressed on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { AuthProvider } from "../../auth/AuthContext";
import { signInOwner } from "../../test/renderWithAuth";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { addDays, mondayOf, parseDay } from "../../lib/dates";
import type {
  WireHarvestCurve,
  WireReportTotals,
  WireReportWeekDetail,
  WireReportWeeksResult,
} from "../../api/wire";
import type { HarvestContext } from "./HarvestLayout";
import { SeasonPage } from "./SeasonPage";

const today = new Date().toISOString().slice(0, 10);
const thisMonday = mondayOf(today);
const weekOf = (back: number) =>
  addDays(parseDay(thisMonday), -7 * back)
    .toISOString()
    .slice(0, 10);

const harvest = vi.hoisted(() => ({
  ctx: {
    today: "",
    weeks: 4,
    days: 28,
    rangeKey: "4",
    canSeeMoney: true,
  } as HarvestContext,
}));

vi.mock("./HarvestLayout", async (orig) => ({
  ...(await orig<typeof import("./HarvestLayout")>()),
  useHarvest: () => harvest.ctx,
}));

const totals = (kg: number | null, records = 3): WireReportTotals => ({
  records,
  kg,
  recordsNotInKg: 0,
  valueCents: kg === null ? null : kg * 1000,
  recordsWithoutValue: 0,
  valueIsEstimate: false,
  recordsSpanningWeeks: 0,
});

const week = (
  weekStart: string,
  kg: number,
  over: Partial<WireReportWeeksResult["items"][number]> = {},
) => ({
  weekStart,
  ...totals(kg),
  pickers: 3,
  days: 2,
  priceCents: 80_000 as number | null,
  finished: true,
  coveredFrom: weekStart,
  coveredTo: addDays(parseDay(weekStart), 6).toISOString().slice(0, 10),
  partialWindow: false,
  ...over,
});

function serve() {
  const items = [
    week(thisMonday, 50, { finished: false }),
    week(weekOf(1), 100, { priceCents: null }),
    week(weekOf(2), 400),
  ];
  const curve: WireHarvestCurve = {
    scope: "harvest",
    plotCropId: null,
    currentWeek: thisMonday,
    weeks: [
      { weekStart: weekOf(2), kg: 400, records: 1 },
      { weekStart: weekOf(1), kg: 100, records: 1 },
      { weekStart: thisMonday, kg: 50, records: 1 },
    ],
    shape: {
      peak: { weekStart: weekOf(2), kg: 400, records: 1 },
      fallingWeeks: 1,
      windingDown: true,
      contiguousWeeks: 3,
    },
    weeksWithoutKilos: 1,
    weeksWithoutRecords: 0,
    coveredFrom: weekOf(2),
    coveredTo: thisMonday,
    partialWindow: false,
  };
  const detail: WireReportWeekDetail = {
    scope: "harvest",
    weekStart: thisMonday,
    finished: true,
    coveredFrom: thisMonday,
    coveredTo: addDays(parseDay(thisMonday), 6).toISOString().slice(0, 10),
    partialWindow: false,
    byDay: {
      columns: [
        { key: thisMonday, label: "lun", total: totals(50) },
        { key: null, label: "Sin día", total: totals(null, 1) },
      ],
      rows: [],
      total: totals(50),
    },
    byCrop: { columns: [], rows: [], total: totals(50) },
    total: totals(50),
  };
  server.use(
    http.get("*/v1/reports/weeks", () =>
      HttpResponse.json({ scope: "harvest", items }),
    ),
    http.get("*/v1/reports/harvest-curve", () => HttpResponse.json(curve)),
    http.get("*/v1/reports/weeks/:monday", () => HttpResponse.json(detail)),
  );
}

function WeekShown() {
  const { week: w } = useParams();
  return <p>Detalle de la semana {w}</p>;
}

function renderSeason() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/detalles"]}>
        <AuthProvider>
          <Routes>
            <Route path="/cosecha/detalles" element={<SeasonPage />} />
            <Route path="/cosecha/semana/:week" element={<WeekShown />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  invalidateRefs();
  signInOwner();
  harvest.ctx = { ...harvest.ctx, today, canSeeMoney: true };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 200,
    top: 0,
    left: 0,
    right: 640,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  serve();
});
afterEach(() => vi.restoreAllMocks());

describe("a season winding down, read by someone who sees money", () => {
  it("says it is ending after one falling week, and names the week left out", async () => {
    renderSeason();
    expect(
      await screen.findByText(/La cosecha va de salida\./, undefined, {
        timeout: 15000,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 semana cayendo/)).toBeInTheDocument();
    expect(
      screen.getByText(/semana quedó fuera de la lectura/),
    ).toBeInTheDocument();
    expect(screen.getByText("Valor de la recolección")).toBeInTheDocument();
  }, 30000);

  it("shows a dash for a week with no price, and a finished week as not running", async () => {
    renderSeason();
    const row = (
      await screen.findByText("Semana pasada", undefined, { timeout: 15000 })
    ).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Recogido esta semana")).toBeInTheDocument();
    expect(screen.getByText("Valor de la semana")).toBeInTheDocument();
    // Only the one day with kilos counts; the day-less column does not.
    expect(screen.getByText("Días con kilo").parentElement).toHaveTextContent(
      "1",
    );
    expect(screen.queryByText(/· en curso/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Kilos recolectados cada día de esta semana.",
      }),
    ).toBeInTheDocument();
  }, 30000);

  it.each([
    "Kilos por semana en barras, 3 semanas.",
    "Personas que recolectaron, 3 semanas.",
    "Valor de la recolección por semana, 3 semanas.",
  ])("opens a week from a bar of «%s»", async (label) => {
    renderSeason();
    const chart = await screen.findByRole(
      "img",
      { name: label },
      { timeout: 15000 },
    );
    await waitFor(() =>
      expect(chart.querySelectorAll("rect").length).toBeGreaterThan(0),
    );
    fireEvent.click(chart.querySelectorAll("rect")[0]);
    expect(
      await screen.findByText(`Detalle de la semana ${weekOf(2)}`),
    ).toBeInTheDocument();
  }, 30000);
});

describe("a member who cannot see money", () => {
  it("shows kilos, people and days but no value anywhere", async () => {
    harvest.ctx = { ...harvest.ctx, canSeeMoney: false };
    renderSeason();
    expect(
      await screen.findByText("Recogido esta semana", undefined, {
        timeout: 15000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Valor de la recolección")).not.toBeInTheDocument();
    expect(screen.queryByText("Valor de la semana")).not.toBeInTheDocument();
    expect(screen.queryByText("Valor por semana")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Precio" }),
    ).not.toBeInTheDocument();
  }, 30000);
});
