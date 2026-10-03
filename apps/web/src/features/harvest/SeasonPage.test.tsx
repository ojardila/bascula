/**
 * «Más detalles de la cosecha», the parts `HarvestPages.test.tsx` leaves out:
 * how the running week reads against the last finished one, the charts and
 * the table taking you to a week, and a season that cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { addDays, mondayOf, parseDay } from "../../lib/dates";
import type { WireHarvestCurve, WireReportWeeksResult } from "../../api/wire";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const HEADING = { name: "Más detalles de la cosecha" };

function renderSeason() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/detalles"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const thisMonday = mondayOf(new Date().toISOString().slice(0, 10));
const weekOf = (back: number) =>
  addDays(parseDay(thisMonday), -7 * back)
    .toISOString()
    .slice(0, 10);

const week = (
  weekStart: string,
  kg: number,
  over: Partial<WireReportWeeksResult["items"][number]> = {},
) => ({
  weekStart,
  records: 4,
  kg,
  recordsNotInKg: 0,
  valueCents: Math.round(kg * 80_000),
  recordsWithoutValue: 0,
  valueIsEstimate: true,
  recordsSpanningWeeks: 0,
  pickers: 3,
  days: 2,
  priceCents: 80_000,
  finished: true,
  coveredFrom: weekStart,
  coveredTo: addDays(parseDay(weekStart), 6).toISOString().slice(0, 10),
  partialWindow: false,
  ...over,
});

/** The running week at `nowKg` against a finished one at `lastKg`. */
function serveSeason(
  nowKg: number,
  lastKg: number,
  peakKg: number | null = 400,
) {
  const items = [
    week(thisMonday, nowKg, { finished: false }),
    week(weekOf(1), lastKg),
    week(weekOf(2), 400),
  ];
  server.use(
    http.get("*/v1/reports/weeks", () =>
      HttpResponse.json({ scope: "harvest", items }),
    ),
    http.get("*/v1/reports/harvest-curve", () =>
      HttpResponse.json({
        scope: "harvest",
        plotCropId: null,
        currentWeek: thisMonday,
        weeks: [
          { weekStart: weekOf(2), kg: 400, records: 1 },
          { weekStart: weekOf(1), kg: lastKg, records: 1 },
          { weekStart: thisMonday, kg: nowKg, records: 1 },
        ],
        shape: {
          peak: { weekStart: weekOf(2), kg: peakKg, records: 1 },
          fallingWeeks: 0,
          windingDown: false,
          contiguousWeeks: 3,
        },
        weeksWithoutKilos: 0,
        weeksWithoutRecords: 0,
        coveredFrom: weekOf(2),
        coveredTo: thisMonday,
        partialWindow: false,
      } satisfies WireHarvestCurve),
    ),
  );
}

beforeEach(() => {
  invalidateRefs();
  localStorage.clear();
  setTokens({
    accessToken: `mock-access.${OWNER}.test`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("the running week against the last finished one", () => {
  it("reads above", async () => {
    serveSeason(150, 100);
    renderSeason();
    expect(
      await screen.findByText(/va por encima de la anterior \(\+50 %\)/),
    ).toBeInTheDocument();
  }, 20000);

  it("reads below", async () => {
    serveSeason(50, 100);
    renderSeason();
    expect(
      await screen.findByText(/va por debajo de la anterior \(−50 %\)/),
    ).toBeInTheDocument();
  }, 20000);

  it("reads similar, and a peak without kilos is named without a figure", async () => {
    serveSeason(101, 100, null);
    renderSeason();
    expect(
      await screen.findByText(
        /va parecida a de la anterior|parecida a la anterior/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ kg\)\./)).not.toBeInTheDocument();
  }, 20000);
});

describe("going to a week", () => {
  it("from a row of the table", async () => {
    serveSeason(150, 100);
    const user = userEvent.setup();
    renderSeason();
    await screen.findByRole("heading", HEADING);
    const row = (await screen.findByText("Semana pasada")).closest("tr");
    await user.click(row!);
    expect(
      await screen.findByText("Volver a la temporada"),
    ).toBeInTheDocument();
  }, 20000);

  it("from a bar of a chart", async () => {
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
    serveSeason(150, 100);
    const { container } = renderSeason();
    await screen.findByRole("heading", HEADING);
    await waitFor(() =>
      expect(container.querySelectorAll("svg rect").length).toBeGreaterThan(0),
    );
    fireEvent.click(container.querySelectorAll("svg rect")[0]);
    expect(
      await screen.findByText("Volver a la temporada"),
    ).toBeInTheDocument();
  }, 20000);
});

describe("a season that cannot be read", () => {
  it("says where the harvest comes from when nothing was picked", async () => {
    server.use(
      http.get("*/v1/reports/weeks", () =>
        HttpResponse.json({ scope: "harvest", items: [] }),
      ),
    );
    renderSeason();
    expect(
      await screen.findByText(/No hay recolección registrada en este periodo/),
    ).toBeInTheDocument();
  }, 20000);

  it("says no figure is zero", async () => {
    server.use(
      http.get("*/v1/reports/weeks", () =>
        HttpResponse.json(
          { error: { code: "BAD_REQUEST", message: "bad" } },
          { status: 400 },
        ),
      ),
    );
    renderSeason();
    expect(
      await screen.findByText(/No se pudo consultar la cosecha/),
    ).toBeInTheDocument();
    expect(screen.getByText(/ninguna de ellas es cero/)).toBeInTheDocument();
  }, 20000);

  it("shows the permission screen on a 403", async () => {
    server.use(
      http.get("*/v1/reports/weeks", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no" } },
          { status: 403 },
        ),
      ),
    );
    renderSeason();
    expect(await screen.findByText(/ver la cosecha/)).toBeInTheDocument();
  }, 20000);
});
