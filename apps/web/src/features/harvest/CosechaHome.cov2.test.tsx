// SPDX-License-Identifier: MIT
/**
 * «Cosecha» home: the paths the page tests leave out — a 403 or a failure on
 * the week summary, a last week with no kilos, a session that may not see
 * money, and the «Modo cosecha» switch failing to save.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { AuthProvider } from "../../auth/AuthContext";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { signInOwner, OWNER } from "../../test/renderWithAuth";
import { FARM_ID } from "../../mocks/db";
import { addDays, mondayOf, parseDay } from "../../lib/dates";
import type { WireReportTotals } from "../../api/wire";
import { HarvestLayout } from "./HarvestLayout";
import { CosechaHome } from "./CosechaHome";

const WEIGHER = "0192f3a0-0001-7000-8000-000000000003";

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

function renderHome() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha"]}>
        <AuthProvider>
          <Routes>
            <Route path="cosecha" element={<HarvestLayout />}>
              <Route index element={<CosechaHome />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function serveWeek(total: WireReportTotals, lastWeekKg: number | null) {
  const grid = {
    columns: [{ key: thisMonday, label: thisMonday, total }],
    rows: [],
    total,
  };
  server.use(
    http.get("*/v1/reports/weeks/:monday", () =>
      HttpResponse.json({
        scope: "harvest",
        weekStart: thisMonday,
        finished: false,
        coveredFrom: thisMonday,
        coveredTo: today,
        partialWindow: false,
        byDay: grid,
        byCrop: grid,
        total,
      }),
    ),
    http.get("*/v1/reports/weeks", () =>
      HttpResponse.json({
        scope: "harvest",
        items: [
          {
            weekStart: lastMonday,
            ...totals({ records: 2, kg: lastWeekKg, recordsNotInKg: lastWeekKg === null ? 2 : 0 }),
            pickers: 1,
            days: 1,
            priceCents: null,
            finished: true,
          },
        ],
      }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  invalidateRefs();
});

describe("CosechaHome, the week summary", () => {
  it("sends the person out of the module when the server refuses the week", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/weeks/:monday", () =>
        HttpResponse.json({ error: { code: "forbidden", message: "forbidden" } }, { status: 403 }),
      ),
    );
    renderHome();
    expect(await screen.findByText("No tiene permiso para ver la cosecha")).toBeInTheDocument();
    expect(screen.queryByText("Recolectores")).not.toBeInTheDocument();
  }, 20000);

  it("says the figures could not be computed when the week fails to load", async () => {
    signInOwner();
    server.use(
      http.get("*/v1/reports/weeks/:monday", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderHome();
    expect(await screen.findByText(/No se pudo consultar la cosecha/)).toBeInTheDocument();
    expect(screen.getByText(/no son cero/)).toBeInTheDocument();
  }, 20000);

  it("leaves out last week's sentence when its kilos are unknown, and hides money from a weigher", async () => {
    signInOwner(WEIGHER);
    serveWeek(totals({ records: 1, kg: 12, valueCents: 1000, valueIsEstimate: true }), null);
    renderHome();
    expect(await screen.findByText("Recolectores")).toBeInTheDocument();
    expect(await screen.findByText("Kilos por día")).toBeInTheDocument();
    expect(screen.queryByText("Valor")).not.toBeInTheDocument();
    expect(screen.queryByText(/La semana pasada se recogieron/)).not.toBeInTheDocument();
    // A weigher cannot flip «Modo cosecha».
    expect(screen.queryByRole("switch", { name: "Modo cosecha" })).not.toBeInTheDocument();
  }, 20000);
});

describe("CosechaHome, last week", () => {
  it("says how many kilos were picked last week when it is known", async () => {
    signInOwner();
    serveWeek(totals({ records: 1, kg: 12, valueCents: 1000 }), 250);
    renderHome();
    expect(await screen.findByText(/La semana pasada se recogieron/)).toHaveTextContent(
      "La semana pasada se recogieron 250 kg.",
    );
  }, 20000);
});

describe("CosechaHome, «Modo cosecha»", () => {
  it("opens straight on the cached mode and puts it back when the save fails", async () => {
    signInOwner(OWNER);
    // The last value this browser saw was «on», so the dashboard is asked for
    // before the farm record arrives.
    localStorage.setItem(`bascula.harvestMode.${FARM_ID}`, "1");
    server.use(
      // The farm record without the flag: «off», as the server's default.
      http.get("*/v1/farm", () => HttpResponse.json({ id: FARM_ID, name: "La Palma" })),
      http.put("*/v1/farm/harvest-mode", () =>
        HttpResponse.json({ error: { code: "internal", message: "boom" } }, { status: 500 }),
      ),
    );
    renderHome();
    const sw = await screen.findByRole("switch", { name: "Modo cosecha" });
    await waitFor(() => expect(sw).not.toBeChecked());
    await waitFor(() => expect(sw).not.toBeDisabled());

    await userEvent.click(sw);
    expect(
      await screen.findByText(
        "No se pudo cambiar el modo cosecha. Revise la conexión e intente otra vez.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Modo cosecha" })).not.toBeChecked();
    expect(screen.getByText("Apagado")).toBeInTheDocument();
  }, 20000);
});
