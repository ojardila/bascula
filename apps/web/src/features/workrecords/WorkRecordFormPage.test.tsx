// SPDX-License-Identifier: MIT
/**
 * «Registrar labor» with no signal: the value shown for kilos paid by the
 * kilo price is the one the server would give — the person's own price, then
 * the lote's, then the week's, then the base — not the base for everybody.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { http, HttpResponse } from "msw";
import { WorkRecordFormPage } from "./WorkRecordFormPage";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import { server } from "../../mocks/node";
import { putCache } from "../../offline/store";
import { recentMondays, syncPriceBook } from "../../offline/priceBook";
import { todayInFarm } from "../../lib/dates";

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const tenant = () => db.tenantOf(db.FARM_ID)!;

function signIn(userId: string) {
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${userId}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${userId}`,
  });
}

function renderForm() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <AuthProvider>
          <WorkRecordFormPage />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  signIn(OWNER);
});

/** A first visit with signal: the lists and the price rules are kept on the device. */
async function visitOnline() {
  const [workers, plots, activities] = await Promise.all([
    api.listWorkers({ status: "active" }),
    api.listPlots({ status: "active" }),
    api.listActivities({ status: "active" }),
  ]);
  await putCache(`refs:${db.FARM_ID}`, { workers, plots, activities });
  await syncPriceBook(db.FARM_ID, recentMondays(todayInFarm("America/Bogota")));
  return { workers, plots };
}

function goOffline() {
  server.use(
    http.get("*/v1/workers", () => HttpResponse.error()),
    http.get("*/v1/plots", () => HttpResponse.error()),
    http.get("*/v1/activities", () => HttpResponse.error()),
    http.get("*/v1/prices/*", () => HttpResponse.error()),
  );
}

async function fill(user: ReturnType<typeof userEvent.setup>, who: string, lote: string, kg: string) {
  await user.click(await screen.findByLabelText(/^Actividad/));
  await user.click(await screen.findByRole("option", { name: "Recolección de café" }));
  await user.click(screen.getByLabelText(/^Empleado/));
  // Test-only: the pattern is built from fixtures in this file, never from user input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  await user.click(await screen.findByRole("option", { name: new RegExp(who) }));
  await user.click(screen.getByLabelText(/^Lotes/));
  await user.click(await screen.findByRole("option", { name: lote }));
  await user.keyboard("{Escape}");
  await user.type(screen.getByLabelText(/^Cantidad/), kg);
}

describe("the provisional value with no signal", () => {
  it("uses the person's own kilo price, not the farm's base price", async () => {
    const t = tenant();
    const [maria] = t.workers;
    const [plot] = t.plots;
    t.basePrices = [{ validFrom: "2000-01-03", priceCents: 80_000, createdAt: "" }];
    t.specialPrices = [
      { kind: "lote", targetId: plot.id, validFrom: "2026-08-17", priceCents: 95_000, createdAt: "" },
      { kind: "persona", targetId: maria.id, validFrom: "2026-09-14", priceCents: 100_000, createdAt: "" },
    ];
    await visitOnline();
    goOffline();

    const user = userEvent.setup();
    renderForm();
    await fill(user, `${maria.name} ${maria.lastName}`, plot.name, "40");

    expect(await screen.findByText(/Precio del kilo, semana del/)).toHaveTextContent("$1.000");
    const box = screen.getByText("Valor provisional").parentElement!;
    expect(within(box).getByText("$40.000")).toBeInTheDocument();
  }, 20000);

  it("uses the lote's price for somebody without their own", async () => {
    const t = tenant();
    const [maria, other] = t.workers;
    const [plot] = t.plots;
    t.basePrices = [{ validFrom: "2000-01-03", priceCents: 80_000, createdAt: "" }];
    t.specialPrices = [
      { kind: "lote", targetId: plot.id, validFrom: "2026-08-17", priceCents: 95_000, createdAt: "" },
      { kind: "persona", targetId: maria.id, validFrom: "2026-09-14", priceCents: 100_000, createdAt: "" },
    ];
    await visitOnline();
    goOffline();

    const user = userEvent.setup();
    renderForm();
    await fill(user, `${other.name} ${other.lastName}`, plot.name, "40");

    expect(await screen.findByText(/Precio del kilo, semana del/)).toHaveTextContent("$950");
    const box = screen.getByText("Valor provisional").parentElement!;
    expect(within(box).getByText("$38.000")).toBeInTheDocument();
  }, 20000);
});
