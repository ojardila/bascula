// SPDX-License-Identifier: MIT
/**
 * «Registro de recolección masivo» parts: a farm with nobody active, a team's
 * row, and two people already settled in a week that is still open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@mui/material";
import { App } from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { setTokens } from "../../api/client";
import { invalidateRefs } from "../../api/refs";
import { api } from "../../api/endpoints";
import { theme } from "../../theme";
import * as db from "../../mocks/db";
import type { WorkRecord } from "../../api/types";

vi.setConfig({ testTimeout: 30_000 });

const OWNER = "0192f3a0-0001-7000-8000-000000000001";
const ALTO = "0192f3a0-0004-7000-8000-000000000001";
const MARIA = "0192f3a0-0006-7000-8000-000000000001";
const JHON = "0192f3a0-0006-7000-8000-000000000002";
const LUZ = "0192f3a0-0006-7000-8000-000000000003";
const TEAM = "0192f3a0-0006-7000-8000-0000000000e1";
const DAY = "2026-08-24";
const PATH = `/cosecha/registro-masivo?dia=${DAY}&lote=${ALTO}`;

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

function pesada(over: Pick<WorkRecord, "id" | "workerId" | "settled">): WorkRecord {
  return {
    workerName: "", activityId: "", activityName: "Recolección",
    category: "cosecha" as never, payMode: "work_unit" as never, unitLabel: "kg",
    plotIds: [ALTO], plotNames: ["Alto"], plotCropIds: [], plotCropNames: [],
    dateFrom: DAY, dateTo: DAY, quantity: 20, rateCents: null,
    estimatedAmountCents: null, amountIsEstimate: null, note: null, status: "active",
    ...over,
  } as WorkRecord;
}

beforeEach(() => {
  db.resetDb();
  invalidateRefs();
  localStorage.clear();
  const now = Date.now();
  setTokens({
    accessToken: `mock-access.${OWNER}.${db.FARM_ID}.${now}.${now + 900_000}`,
    refreshToken: `mock-refresh.${OWNER}`,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Registro masivo parts", () => {
  it("asks to register people first when nobody is active", async () => {
    for (const w of db.tenantOf(db.FARM_ID)!.workers) w.deletedAt = "2026-01-01T00:00:00Z";
    renderApp(PATH);
    expect(
      await screen.findByText("No hay empleados activos. Regístrelos primero en Empleados."),
    ).toBeInTheDocument();
  });

  it("names a team's people under its row", async () => {
    await api.createWorker({
      id: TEAM, name: "Cuadrilla Norte", tag: "40", kind: "equipo", memberIds: [JHON, LUZ],
    } as never);
    invalidateRefs();
    renderApp(PATH);
    expect(await screen.findByLabelText(/^Cuadrilla Norte.*, kilos$/)).toBeInTheDocument();
    expect(screen.getByText(/· .*Jhon.*Luz/)).toBeInTheDocument();
  });

  it("counts the people settled in a week that is still open", async () => {
    vi.spyOn(api, "listWorkRecords").mockResolvedValue([
      pesada({ id: "s1", workerId: JHON, settled: true }),
      pesada({ id: "s2", workerId: LUZ, settled: true }),
      pesada({ id: "o1", workerId: MARIA, settled: false }),
    ]);
    renderApp(PATH);
    expect(
      await screen.findByText("A 2 personas ya se les liquidó esta semana: sus kilos no se pueden cambiar."),
    ).toBeInTheDocument();
  });
});
