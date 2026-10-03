// SPDX-License-Identifier: MIT
/**
 * The crops screen: one card per crop of every lot, heaviest first, with the
 * figures that must never read as zero shown as a dash with their reason.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { theme } from "../../theme";
import { server } from "../../mocks/node";
import { FARM_ID, resetDb, tenantOf } from "../../mocks/db";
import { addDays, mondayOf, parseDay } from "../../lib/dates";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const thisMonday = mondayOf(new Date().toISOString().slice(0, 10));
const weekOf = (back: number) =>
  addDays(parseDay(thisMonday), -7 * back)
    .toISOString()
    .slice(0, 10);

function renderCrops() {
  setTokens({
    accessToken: `mock-access.${OWNER}.test`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={["/cosecha/cultivos"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** The ids of every crop of every active seeded plot, in plot order. */
function cropIds(): string[] {
  return tenantOf(FARM_ID)!
    .plots.filter((p) => !p.deletedAt)
    .flatMap((p) => (p.crops ?? []).map((c) => c.id));
}

function week(back: number, kg: number, finished = true) {
  return {
    weekStart: weekOf(back),
    records: 2,
    kg,
    recordsNotInKg: 0,
    valueCents: kg * 800,
    recordsWithoutValue: 0,
    valueIsEstimate: false,
    recordsSpanningWeeks: 0,
    pickers: 2,
    days: 2,
    finished,
  };
}

function crop(id: string, label: string, over: Record<string, unknown> = {}) {
  return {
    scope: "harvest",
    plotCropId: id,
    label,
    records: 4,
    kg: 300,
    recordsNotInKg: 0,
    valueCents: 240000,
    recordsWithoutValue: 0,
    valueIsEstimate: false,
    recordsSpanningWeeks: 0,
    pickers: 3,
    days: 4,
    firstOn: weekOf(1),
    lastOn: weekOf(0),
    areaHa: 2,
    kgPerHa: 150,
    sharedRecords: 0,
    byWeek: [week(0, 100, false), week(1, 200)],
    ...over,
  };
}

/** Answers each crop id with the body `make` builds, or a 500 for null. */
function serveCrops(make: (id: string, i: number) => object | null) {
  const ids = cropIds();
  server.use(
    http.get("*/v1/reports/crops/:id", ({ params }) => {
      const i = ids.indexOf(String(params.id));
      const body = make(String(params.id), i);
      return body
        ? HttpResponse.json(body)
        : HttpResponse.json(
            { error: { code: "INTERNAL", message: "x" } },
            { status: 500 },
          );
    }),
  );
}

beforeEach(() => {
  resetDb();
  invalidateRefs();
});

describe("the crops screen", () => {
  it("lists crops heaviest first and warns about a crop it could not read", async () => {
    expect(cropIds().length).toBeGreaterThan(1);
    serveCrops((id, i) => {
      if (i === 0)
        return crop(id, "Café — Lote Liviano", { kg: 50, sharedRecords: 1 });
      if (i === 1)
        return crop(id, "Café — Lote Pesado", { kg: 900, sharedRecords: 3 });
      return null;
    });
    renderCrops();

    const heavy = await screen.findByText("Café — Lote Pesado");
    const light = screen.getByText("Café — Lote Liviano");
    // Heaviest first.
    expect(
      heavy.compareDocumentPosition(light) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("3 compartidas")).toBeInTheDocument();
    expect(screen.getByText("1 compartidas")).toBeInTheDocument();
    if (cropIds().length > 2) {
      expect(
        screen.getByText(/no se pudieron consultar|no se pudo consultar/),
      ).toBeInTheDocument();
    }
    // The running week is marked, and every week has its row.
    expect(screen.getAllByText("en curso").length).toBeGreaterThan(0);
  });

  it("shows a dash, not a zero, when there is no area or no kilos", async () => {
    serveCrops((id, i) => {
      if (i === 0)
        return crop(id, "Sin área", {
          areaHa: null,
          kgPerHa: null,
          firstOn: null,
          lastOn: null,
          byWeek: [week(0, 10)],
        });
      if (i === 1) return crop(id, "Sin kilos", { kg: null, kgPerHa: null });
      return crop(id, `Otro ${i}`, { records: 0, byWeek: [] });
    });
    renderCrops();

    const card = (await screen.findByText("Sin área")).closest(
      ".MuiCard-root",
    ) as HTMLElement;
    expect(
      within(card).getByText("Sin fechas de recolección"),
    ).toBeInTheDocument();
    expect(within(card).getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("Sin kilos")).toBeInTheDocument();
    expect(screen.queryByText(/^Otro /)).not.toBeInTheDocument();
  });

  it("says so when no crop has a harvest in the period", async () => {
    serveCrops((id) => crop(id, "Nada", { records: 0 }));
    renderCrops();
    expect(
      await screen.findByText(
        /Ninguno de los cultivos de la finca tiene recolección/,
      ),
    ).toBeInTheDocument();
  });

  it("explains a failure to read the plots instead of showing zeros", async () => {
    server.use(
      http.get("*/v1/plots", () =>
        HttpResponse.json(
          { error: { code: "INTERNAL", message: "caído" } },
          { status: 500 },
        ),
      ),
    );
    renderCrops();
    expect(
      await screen.findByText(/No se pudieron consultar los cultivos/),
    ).toBeInTheDocument();
  });
});
